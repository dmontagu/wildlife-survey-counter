"""Evaluate a fine-tuned elk detector on the held-out test images.

Runs full-image SAHI inference (640px tiles — matching training scale, no
magnification) on every image in data/training/splits.json's test list,
NMS-merges, and scores against reviewed labels with eval_annotations.

Usage:
    uv run python scripts/eval_model.py --weights <best.pt> [--conf 0.2]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

from scripts.auto_annotate import find_image, sahi_pass  # noqa: E402
from scripts.eval_annotations import (  # noqa: E402
    aggregate,
    eval_pair,
    load_manifest,
    print_row,
)
from scripts.hybrid_annotate import nms_points  # noqa: E402

DATASET_DIR = BASE_DIR / "data" / "dataset"
OUT_DIR = BASE_DIR / "storage" / "output" / "evals"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, type=Path)
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--tile", type=int, default=640)
    args = ap.parse_args()

    splits = json.loads((BASE_DIR / "data" / "training" / "splits.json").read_text())
    calib = json.loads((DATASET_DIR / "calibration.json").read_text())
    manifest = load_manifest()

    results: dict[str, dict] = {}
    out_dir = OUT_DIR / f"model_{args.weights.parent.parent.name}"
    out_dir.mkdir(parents=True, exist_ok=True)

    for stem in splits["test"]:
        entry = manifest.get(stem.lower())
        if entry is None:
            print(f"{stem}: no manifest entry, skipping")
            continue
        if entry.get("tier") == "unreviewed-suspect":
            print(f"{stem}: unreviewed-suspect labels, skipping")
            continue
        image_path = find_image(stem)
        elk = (calib.get(stem) or {}).get("elk_px") or entry.get("est_elk_size_px") or 20
        nms = max(8, int(min(120, elk) / 2))
        dets = sahi_pass(image_path, conf=args.conf, tile=args.tile,
                         overlap=0.25, model_path=args.weights)
        merged = nms_points(dets, min_dist=nms)
        pred_path = out_dir / f"{stem}.json"
        pred_path.write_text(json.dumps(
            [{"x": d["x"], "y": d["y"], "confidence": d["conf"]} for d in merged]))
        radius = max(8.0, min(40.0, 0.75 * min(120.0, float(elk))))
        r = eval_pair(pred_path, DATASET_DIR / entry["label_file"], radius)
        results[stem] = r
        print_row(stem, r)

    agg = aggregate(results)
    print(f"\nAggregate: {json.dumps(agg)}")
    (out_dir / "summary.json").write_text(json.dumps(
        {"weights": str(args.weights), "conf": args.conf, "tile": args.tile,
         "per_image": results, "aggregate": agg}, indent=1))
    print(f"Saved -> {out_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
