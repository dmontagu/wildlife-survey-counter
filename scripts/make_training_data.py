"""Export YOLO-format training tiles from the canonical dataset.

- 640px tiles, stride 512, from every non-TEST image
- keeps all tiles containing >=1 elk point, all tiles containing rejected
  false-positive points (hard negatives, exported label-free), and a
  deterministic ~15% sample of empty tiles
- boxes: square pseudo-boxes centered on points, side = per-image elk_px from
  data/dataset/calibration.json (bbox median, clamped to [10, 120]; NN
  fallback), normalized YOLO class 0
- TEST images are never tiled; they are evaluated at full image via
  scripts/eval_annotations.py

Output: data/training/{images,labels}/{train,val}/, dataset.yaml, splits.json
Usage: uv run python scripts/make_training_data.py
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from PIL import Image

BASE_DIR = Path(__file__).parent.parent
DATASET_DIR = BASE_DIR / "data" / "dataset"
IMAGES_DIR = BASE_DIR / "data" / "elk_images_from_fwp"
OUT_DIR = BASE_DIR / "data" / "training"

TILE, STRIDE = 640, 512
EMPTY_KEEP = 0.15
SEED = 13

# Held-out test set: never tiled, never trained on. Stratified by background,
# elk size, density, and known failure mode.
TEST = {"DSC00465", "DSC00608", "DSC01410", "DSC01988", "DSC01086",
        "IMG_3835", "IMG_3930", "IMG_3706", "20220226_104722", "wpt 103"}
# Validation images (early stopping); tiled like train but kept separate.
VAL = {"DSC00577", "DSC01248", "IMG_3831", "DSC00756", "IMG_3712", "DSC01778"}


def main() -> None:
    rng = random.Random(SEED)
    with open(DATASET_DIR / "manifest.json") as f:
        manifest = json.load(f)
    calib = json.loads((DATASET_DIR / "calibration.json").read_text())

    for split in ("train", "val"):
        (OUT_DIR / "images" / split).mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "labels" / split).mkdir(parents=True, exist_ok=True)

    stats = {"train": [0, 0], "val": [0, 0]}  # tiles, boxes
    for m in manifest["images"]:
        stem = m["stem"]
        if stem in TEST or not m["image_file"]:
            continue
        if m["tier"] == "unreviewed-suspect":
            print(f"{stem}: SKIPPED (unreviewed-suspect)", flush=True)
            continue
        split = "val" if stem in VAL else "train"
        c = calib.get(stem) or {}
        elk = c.get("elk_px") or m.get("est_elk_size_px") or 20
        box = max(10.0, min(120.0, float(elk)))

        with open(DATASET_DIR / m["label_file"]) as f:
            anns = json.load(f)["annotations"]
        pts = [(a["x"], a["y"]) for a in anns if a["state"] != "rejected"]
        neg = [(a["x"], a["y"]) for a in anns
               if a["state"] == "rejected"
               and a.get("rejected_kind") == "false-positive"]

        img = Image.open(IMAGES_DIR / m["image_file"])
        w, h = img.size
        for ty in range(0, max(1, h - TILE + STRIDE), STRIDE):
            for tx in range(0, max(1, w - TILE + STRIDE), STRIDE):
                x1, y1 = min(tx, w - TILE), min(ty, h - TILE)
                inside = [(x - x1, y - y1) for x, y in pts
                          if x1 <= x < x1 + TILE and y1 <= y < y1 + TILE]
                has_neg = any(x1 <= x < x1 + TILE and y1 <= y < y1 + TILE
                              for x, y in neg)
                if not inside and not has_neg and rng.random() > EMPTY_KEEP:
                    continue
                name = f"{stem}_{x1}_{y1}"
                img.crop((x1, y1, x1 + TILE, y1 + TILE)).save(
                    OUT_DIR / "images" / split / f"{name}.jpg", quality=92)
                lines = []
                for cx, cy in inside:
                    bw = box / TILE
                    lines.append(f"0 {cx / TILE:.6f} {cy / TILE:.6f} "
                                 f"{bw:.6f} {bw:.6f}")
                (OUT_DIR / "labels" / split / f"{name}.txt").write_text(
                    "\n".join(lines))
                stats[split][0] += 1
                stats[split][1] += len(inside)
        print(f"{stem} [{split}] box={box:.0f} pts={len(pts)}", flush=True)

    (OUT_DIR / "dataset.yaml").write_text(
        f"path: {OUT_DIR}\ntrain: images/train\nval: images/val\n"
        "names:\n  0: elk\n")
    (OUT_DIR / "splits.json").write_text(json.dumps(
        {"test": sorted(TEST), "val": sorted(VAL)}, indent=1))
    print(f"train: {stats['train'][0]} tiles / {stats['train'][1]} boxes | "
          f"val: {stats['val'][0]} tiles / {stats['val'][1]} boxes")


if __name__ == "__main__":
    main()
