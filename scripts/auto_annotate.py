"""End-to-end automated annotation pipeline with VLM verification.

Stages (run in order; each writes into storage/output/auto_annotate/<stem>/):

  propose   Calibrate elk size (640-tile SAHI pass), pick tile size by the
            playbook formula, run high-recall SAHI, NMS -> proposals.json
  sheets    Render verification contact sheets for every proposal, plus
            adaptive recall-sweep cells around proposal clusters. The judge
            (in-session VLM, subagent, or API model) fills in verdicts files.
  finalize  Apply verify_verdicts.json + sweep_verdicts.json -> bundle.json
            (frontend-importable), and evaluate against dataset GT if present.

Usage:
    uv run python scripts/auto_annotate.py propose DSC00608 [--tile 320] [--conf 0.01]
    uv run python scripts/auto_annotate.py sheets DSC00608
    uv run python scripts/auto_annotate.py finalize DSC00608
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

IMAGES_DIR = BASE_DIR / "data" / "elk_images_from_fwp"
DATASET_DIR = BASE_DIR / "data" / "dataset"
MODEL_PATH = BASE_DIR / "storage" / "models" / "yolov8x.pt"
OUT_ROOT = BASE_DIR / "storage" / "output" / "auto_annotate"

CELL_RENDER = 640
SHEET_CELL = 224
SHEET_GRID = 4
CONTEXT_MULT = 8.0
SWEEP_CELL_MULT = 24  # cell side in elk sizes; halved when proposal-dense
MARGIN_FRAC = 0.08


def find_image(stem: str) -> Path:
    for p in IMAGES_DIR.iterdir():
        if p.stem.lower() == stem.lower():
            return p
    raise SystemExit(f"No image matching {stem} in {IMAGES_DIR}")


def out_dir(stem: str) -> Path:
    d = OUT_ROOT / stem
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------
# propose
# --------------------------------------------------------------------------

def sahi_pass(
    image_path: Path, conf: float, tile: int, overlap: float,
    model_path: Path | None = None,
) -> list[dict]:
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction

    # COCO-pretrained yolov8x classifies elk as horse/sheep/cow/etc.; a
    # fine-tuned elk model has a single class 0 that must not be filtered.
    custom = model_path is not None
    animal_ids = {0} if custom else {16, 17, 18, 19, 20, 21, 22, 23, 24, 25}
    model = AutoDetectionModel.from_pretrained(
        model_type="yolov8", model_path=str(model_path or MODEL_PATH),
        confidence_threshold=conf, device="mps",
    )
    result = get_sliced_prediction(
        str(image_path), model,
        slice_height=tile, slice_width=tile,
        overlap_height_ratio=overlap, overlap_width_ratio=overlap,
        verbose=0,
    )
    dets = []
    for pred in result.object_prediction_list:
        if pred.category.id in animal_ids:
            b = pred.bbox
            dets.append({
                "x": round((b.minx + b.maxx) / 2),
                "y": round((b.miny + b.maxy) / 2),
                "w": round(b.maxx - b.minx),
                "h": round(b.maxy - b.miny),
                "conf": round(float(pred.score.value), 4),
                "class": pred.category.name,
            })
    return dets


def propose(stem: str, tile: int | None, conf: float, weights=None) -> None:
    from scripts.hybrid_annotate import nms_points

    image_path = find_image(stem)
    d = out_dir(stem)

    # Calibration pass: 640 tiles, moderate confidence, just to size the elk.
    print("Calibration pass (640px tiles)...")
    calib = sahi_pass(image_path, conf=0.2 if weights else 0.03, tile=640, overlap=0.2, model_path=weights)
    widths = sorted(det["w"] for det in calib)
    elk_px = statistics.median(widths) if widths else 20.0
    print(f"  {len(calib)} calibration detections, median bbox width {elk_px:.0f}px")

    if tile is None:
        ideal = int(min(640, max(192, 640 * elk_px / 40)))
        tile = min((256, 320, 480, 640), key=lambda t: abs(t - ideal))
    nms_dist = max(8, int(elk_px / 2))

    print(f"Detection pass: tile={tile}, conf={conf}, nms={nms_dist}...")
    dets = sahi_pass(image_path, conf=conf, tile=tile, overlap=0.3, model_path=weights)
    merged = nms_points(dets, min_dist=nms_dist)
    print(f"  {len(dets)} raw -> {len(merged)} after NMS")

    with Image.open(image_path) as img:
        width, height = img.size
    payload = {
        "stem": stem,
        "image_file": image_path.name,
        "width": width,
        "height": height,
        "elk_px": round(elk_px, 1),
        "tile": tile,
        "conf": conf,
        "nms_dist": nms_dist,
        "proposals": [
            {"id": i + 1, **det} for i, det in enumerate(merged)
        ],
    }
    with open(d / "proposals.json", "w") as f:
        json.dump(payload, f, indent=1)
    print(f"Wrote {d / 'proposals.json'}")


# --------------------------------------------------------------------------
# sheets
# --------------------------------------------------------------------------

def make_crop(img: Image.Image, x: float, y: float, crop: int, mark_r: float) -> Image.Image:
    w, h = img.size
    x1 = max(0, min(int(x) - crop // 2, w - crop))
    y1 = max(0, min(int(y) - crop // 2, h - crop))
    cell = img.crop((x1, y1, x1 + crop, y1 + crop)).resize(
        (SHEET_CELL, SHEET_CELL), Image.Resampling.LANCZOS
    )
    scale = SHEET_CELL / crop
    cx, cy = (x - x1) * scale, (y - y1) * scale
    draw = ImageDraw.Draw(cell)
    r = max(10.0, mark_r * scale)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(0, 255, 255), width=2)
    return cell


def sheets(stem: str) -> None:
    d = out_dir(stem)
    with open(d / "proposals.json") as f:
        p = json.load(f)
    img = Image.open(IMAGES_DIR / p["image_file"])
    elk_px = max(5.0, min(60.0, p["elk_px"]))
    crop = max(96, int(CONTEXT_MULT * elk_px))

    # --- verification sheets: every proposal, 16 per sheet ---
    props = p["proposals"]
    per_sheet = SHEET_GRID * SHEET_GRID
    verify_index = {}
    for s in range((len(props) + per_sheet - 1) // per_sheet):
        sheet = Image.new("RGB", (SHEET_GRID * SHEET_CELL, SHEET_GRID * SHEET_CELL), (20, 20, 20))
        draw = ImageDraw.Draw(sheet)
        for i, prop in enumerate(props[s * per_sheet:(s + 1) * per_sheet]):
            row, col = divmod(i, SHEET_GRID)
            cell = make_crop(img, prop["x"], prop["y"], crop, 1.4 * elk_px)
            sheet.paste(cell, (col * SHEET_CELL, row * SHEET_CELL))
            cid = f"{chr(65 + row)}{col + 1}"
            draw.rectangle([col * SHEET_CELL, row * SHEET_CELL,
                            col * SHEET_CELL + 34, row * SHEET_CELL + 20], fill=(0, 0, 0))
            draw.text((col * SHEET_CELL + 4, row * SHEET_CELL + 4), cid, fill=(255, 255, 0))
            verify_index[f"verify{s + 1}:{cid}"] = prop["id"]
        sheet.save(d / f"verify{s + 1}.jpg", quality=90)

    # --- sweep cells: tiles holding proposals + their neighbors ---
    cell_px = int(SWEEP_CELL_MULT * elk_px)
    cols = (p["width"] + cell_px - 1) // cell_px
    rows = (p["height"] + cell_px - 1) // cell_px
    counts: dict[tuple[int, int], int] = {}
    for prop in props:
        key = (min(int(prop["x"] // cell_px), cols - 1),
               min(int(prop["y"] // cell_px), rows - 1))
        counts[key] = counts.get(key, 0) + 1

    chosen: set[tuple[int, int]] = set()
    for (cx, cy) in counts:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < cols and 0 <= ny < rows:
                    chosen.add((nx, ny))

    def props_in(tx: int, ty: int, tw: int, th: int) -> int:
        return sum(1 for pr in props
                   if tx <= pr["x"] < tx + tw and ty <= pr["y"] < ty + th)

    # Recursively subdivide proposal-dense tiles: VLM counting degrades above
    # ~8-10 animals per view, and proposal counts undercount true density.
    tiles: list[tuple[int, int, int, int]] = []

    def emit(tx: int, ty: int, tw: int, th: int, depth: int) -> None:
        if depth < 2 and props_in(tx, ty, tw, th) >= 4 and min(tw, th) >= 300:
            hw, hh = tw // 2, th // 2
            for ox, oy in ((0, 0), (hw, 0), (0, hh), (hw, hh)):
                emit(tx + ox, ty + oy, tw - hw if ox else hw, th - hh if oy else hh,
                     depth + 1)
        else:
            tiles.append((tx, ty, tw, th))

    for (cx, cy) in sorted(chosen):
        tx, ty = cx * cell_px, cy * cell_px
        emit(tx, ty, min(cell_px, p["width"] - tx), min(cell_px, p["height"] - ty), 0)

    sweep_index = {}
    for n, (tx, ty, tw, th) in enumerate(tiles, start=1):
        crop_img = img.crop((tx, ty, tx + tw, ty + th)).resize(
            (CELL_RENDER, CELL_RENDER), Image.Resampling.LANCZOS
        )
        name = f"sweep{n:03d}"
        crop_img.save(d / f"{name}.jpg", quality=90)
        sweep_index[name] = {
            "x": tx, "y": ty, "w": tw, "h": th,
            "proposals_inside": props_in(tx, ty, tw, th),
        }

    with open(d / "sheet_index.json", "w") as f:
        json.dump({
            "elk_px": elk_px, "crop_px": crop, "cell_px": cell_px,
            "n_verify_sheets": (len(props) + per_sheet - 1) // per_sheet,
            "verify": verify_index,
            "sweep": sweep_index,
        }, f, indent=1)
    print(f"Wrote {(len(props) + per_sheet - 1) // per_sheet} verify sheets, "
          f"{len(sweep_index)} sweep cells -> {d}")


# --------------------------------------------------------------------------
# finalize
# --------------------------------------------------------------------------

def finalize(stem: str) -> None:
    d = out_dir(stem)
    with open(d / "proposals.json") as f:
        p = json.load(f)
    with open(d / "sheet_index.json") as f:
        index = json.load(f)
    with open(d / "verify_verdicts.json") as f:
        verify_verdicts = json.load(f)
    sweep_path = d / "sweep_verdicts.json"
    sweep_verdicts = json.loads(sweep_path.read_text()) if sweep_path.exists() else {}

    elk_px = index["elk_px"]
    verdict_by_id = {}
    for cell_ref, prop_id in index["verify"].items():
        v = verify_verdicts.get(cell_ref)
        if v is not None:
            verdict_by_id[prop_id] = v

    kept, dropped = [], []
    for prop in p["proposals"]:
        v = verdict_by_id.get(prop["id"], "unjudged")
        (kept if v == "elk" else dropped).append((prop, v))

    annotations = []
    for i, (prop, _) in enumerate(kept):
        annotations.append({
            "id": i + 1, "x": prop["x"], "y": prop["y"], "bbox": None,
            "detection_confidence": prop["conf"],
            "classification_confidence": None,
            "source": "auto+vlm-verified", "label": "elk", "category": None,
            "state": "auto-detected", "reviewStatus": "unconfirmed",
        })

    # Sweep additions: judged points not already covered by a kept annotation.
    # Cells whose reported points are implausibly dense (median nearest-neighbor
    # spacing well below one animal body) are texture hallucinations — drop them
    # and record for re-judging at higher zoom.
    suspect_cells = []
    added = 0
    for name, verdict in sweep_verdicts.items():
        cell = index["sweep"][name]
        pts = verdict.get("points", [])
        if len(pts) >= 8:
            rendered_elk = elk_px * CELL_RENDER / cell["w"]
            nn = sorted(
                min((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
                    for b in pts if b is not a) ** 0.5
                for a in pts
            )
            if nn[len(nn) // 2] < 0.35 * rendered_elk:
                suspect_cells.append({"cell": name, "count": len(pts),
                                      "median_nn_px": round(nn[len(nn) // 2], 1)})
                continue
        for px, py in verdict.get("points", []):
            # points come in render coords (0..640) -> map to image coords
            ix = cell["x"] + px / CELL_RENDER * cell["w"]
            iy = cell["y"] + py / CELL_RENDER * cell["h"]
            if any((a["x"] - ix) ** 2 + (a["y"] - iy) ** 2 <= (0.5 * elk_px) ** 2
                   for a in annotations):
                continue
            added += 1
            annotations.append({
                "id": len(annotations) + 1, "x": round(ix), "y": round(iy),
                "bbox": None, "detection_confidence": None,
                "classification_confidence": None,
                "source": "vlm-sweep", "label": "elk", "category": None,
                "state": "auto-detected", "reviewStatus": "unconfirmed",
            })

    bundle = {
        "image": {"filename": p["image_file"], "displayName": None,
                  "width": p["width"], "height": p["height"]},
        "summary": {"total": len(annotations)},
        "annotations": annotations,
        "metadata": {
            "generator": "scripts/auto_annotate.py",
            "proposals": len(p["proposals"]),
            "verified_elk": len(kept),
            "verified_not_elk": sum(1 for _, v in dropped if v == "not-elk"),
            "unjudged": sum(1 for _, v in dropped if v == "unjudged"),
            "sweep_added": added,
            "suspect_cells": suspect_cells,
            "detector": {"tile": p["tile"], "conf": p["conf"], "nms": p["nms_dist"]},
        },
    }
    with open(d / "bundle.json", "w") as f:
        json.dump(bundle, f, indent=1)
    print(f"bundle.json: {len(annotations)} annotations "
          f"({len(kept)} verified detections + {added} sweep additions; "
          f"{bundle['metadata']['verified_not_elk']} dropped as not-elk, "
          f"{bundle['metadata']['unjudged']} unjudged)")

    # Evaluate if ground truth exists.
    gt_path = DATASET_DIR / "labels" / f"{Path(p['image_file']).stem}.json"
    if gt_path.exists():
        from scripts.eval_annotations import eval_pair, load_manifest, radius_for
        entry = load_manifest().get(stem.lower())
        r = eval_pair(d / "bundle.json", gt_path, radius_for(entry, None))
        print(f"EVAL vs reviewed GT: {json.dumps(r)}")
        with open(d / "eval.json", "w") as f:
            json.dump(r, f, indent=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["propose", "sheets", "finalize"])
    ap.add_argument("stem")
    ap.add_argument("--tile", type=int, default=None)
    ap.add_argument("--conf", type=float, default=0.01)
    ap.add_argument("--weights", type=Path, default=None)
    args = ap.parse_args()
    if args.stage == "propose":
        propose(args.stem, args.tile, args.conf, args.weights)
    elif args.stage == "sheets":
        sheets(args.stem)
    else:
        finalize(args.stem)


if __name__ == "__main__":
    main()
