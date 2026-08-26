"""Build grid-cell crops for VLM counting experiments.

Samples cells stratified by ground-truth density (empty / sparse / medium /
dense), renders each as a zoomed crop, and writes a blind key with the true
point count per cell. Points within a margin of the cell edge are excluded
from the expected count (and the crop is drawn with the margin marked) so
edge-straddling animals don't make the count ambiguous.

Usage:
    python scripts/make_count_cells.py DSC01410
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BASE_DIR = Path(__file__).parent.parent
DATASET_DIR = BASE_DIR / "data" / "dataset"
IMAGES_DIR = BASE_DIR / "data" / "elk_images_from_fwp"
OUT_DIR = BASE_DIR / "storage" / "output" / "count_experiment"

CELL_MULT = 24  # cell side in elk-size units
RENDER = 640
MARGIN_FRAC = 0.08  # frame inset marking the counting boundary
SEED = 7
PER_BUCKET = 3

KEPT_STATES = {"auto-detected", "confirmed", "manually-added"}


def main(stem: str) -> None:
    with open(DATASET_DIR / "manifest.json") as f:
        manifest = json.load(f)
    entry = next(m for m in manifest["images"] if m["stem"].lower() == stem.lower())
    with open(DATASET_DIR / entry["label_file"]) as f:
        labels = json.load(f)

    elk_size = max(5.0, min(60.0, entry.get("est_elk_size_px") or 20.0))
    cell_px = int(CELL_MULT * elk_size)
    pts = [
        (a["x"], a["y"]) for a in labels["annotations"] if a["state"] in KEPT_STATES
    ]

    img = Image.open(IMAGES_DIR / entry["image_file"])
    w, h = img.size
    rng = random.Random(SEED)

    # Tile the image; count interior points per tile.
    margin = int(cell_px * MARGIN_FRAC)
    tiles = []
    for ty in range(0, h - cell_px, cell_px):
        for tx in range(0, w - cell_px, cell_px):
            inner = (tx + margin, ty + margin, tx + cell_px - margin, ty + cell_px - margin)
            n = sum(1 for x, y in pts if inner[0] <= x < inner[2] and inner[1] <= y < inner[3])
            tiles.append((tx, ty, n))

    buckets = {
        "empty": [t for t in tiles if t[2] == 0],
        "sparse": [t for t in tiles if 1 <= t[2] <= 4],
        "medium": [t for t in tiles if 5 <= t[2] <= 15],
        "dense": [t for t in tiles if t[2] > 15],
    }

    out_dir = OUT_DIR / stem
    out_dir.mkdir(parents=True, exist_ok=True)
    key = {"stem": stem, "cell_px": cell_px, "elk_size_px": elk_size, "cells": {}}

    i = 0
    for bucket, ts in buckets.items():
        chosen = rng.sample(ts, min(PER_BUCKET, len(ts)))
        for tx, ty, n in chosen:
            i += 1
            crop = img.crop((tx, ty, tx + cell_px, ty + cell_px)).resize(
                (RENDER, RENDER), Image.Resampling.LANCZOS
            )
            draw = ImageDraw.Draw(crop)
            m = int(RENDER * MARGIN_FRAC)
            draw.rectangle([m, m, RENDER - m, RENDER - m], outline=(0, 255, 255), width=2)
            name = f"cell{i:02d}.jpg"
            crop.save(out_dir / name, quality=90)
            key["cells"][name] = {"bucket": bucket, "count": n, "x": tx, "y": ty}

    with open(out_dir / "key.json", "w") as f:
        json.dump(key, f, indent=1)
    print(f"{stem}: wrote {i} cells (cell={cell_px}px, elk~{elk_size:.0f}px) "
          f"buckets: {{k: len(v) for k, v in buckets.items()}}="
          f"{ {k: len(v) for k, v in buckets.items()} }")


if __name__ == "__main__":
    for s in sys.argv[1:] or ["DSC01410"]:
        main(s)
