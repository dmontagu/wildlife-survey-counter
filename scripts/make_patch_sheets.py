"""Build shuffled patch contact sheets for VLM verification experiments.

For each requested image, samples annotation patches from four categories:
  - tp:  kept auto-detections            (expected verdict: elk)
  - fn:  manually-added points           (expected verdict: elk — detector missed these)
  - fp:  rejected detections             (expected verdict: not-elk)
  - bg:  random points far from any ann  (expected verdict: not-elk)

Patches are cropped at CONTEXT_MULT x est elk size, center-marked with a circle,
upscaled to CELL px, shuffled across categories, and tiled into 4x4 sheets.
The answer key is written separately so the sheets can be judged blind.

Usage:
    python scripts/make_patch_sheets.py DSC01274 DSC01410 DSC00465
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
OUT_DIR = BASE_DIR / "storage" / "output" / "patch_experiment"

PER_CATEGORY = 12
CONTEXT_MULT = 8.0
MIN_CROP = 96
CELL = 224
GRID = 4  # 4x4 cells per sheet
SEED = 42

KEPT_STATES = {"auto-detected", "confirmed", "manually-added"}


def load_manifest_entry(stem: str) -> dict:
    with open(DATASET_DIR / "manifest.json") as f:
        manifest = json.load(f)
    for m in manifest["images"]:
        if m["stem"].lower() == stem.lower():
            return m
    raise SystemExit(f"No manifest entry for {stem}")


def sample_categories(annotations: list[dict], rng: random.Random) -> dict[str, list[dict]]:
    cats: dict[str, list[dict]] = {
        "tp": [a for a in annotations if a["state"] == "auto-detected"],
        "fn": [a for a in annotations if a["state"] == "manually-added"],
        "fp": [a for a in annotations if a["state"] == "rejected"],
    }
    return {
        name: rng.sample(items, min(PER_CATEGORY, len(items)))
        for name, items in cats.items()
        if items
    }


def sample_background(
    annotations: list[dict], width: int, height: int, elk_size: float, rng: random.Random
) -> list[dict]:
    pts = [(a["x"], a["y"]) for a in annotations]
    min_dist = 6 * elk_size
    out = []
    attempts = 0
    while len(out) < PER_CATEGORY and attempts < 3000:
        attempts += 1
        x = rng.uniform(width * 0.05, width * 0.95)
        y = rng.uniform(height * 0.05, height * 0.95)
        if all((x - px) ** 2 + (y - py) ** 2 > min_dist**2 for px, py in pts):
            out.append({"x": x, "y": y})
    return out


def make_cell(img: Image.Image, x: float, y: float, crop_size: int, elk_size: float) -> Image.Image:
    w, h = img.size
    half = crop_size // 2
    x1, y1 = int(x) - half, int(y) - half
    x2, y2 = x1 + crop_size, y1 + crop_size
    # Pad at edges by clamping the crop window inside the image.
    x1 = max(0, min(x1, w - crop_size))
    y1 = max(0, min(y1, h - crop_size))
    x2, y2 = x1 + crop_size, y1 + crop_size
    cell = img.crop((x1, y1, x2, y2)).resize((CELL, CELL), Image.Resampling.LANCZOS)

    # Circle around the queried point (in cell coordinates).
    scale = CELL / crop_size
    cx, cy = (x - x1) * scale, (y - y1) * scale
    r = max(10.0, 1.4 * elk_size * scale)
    draw = ImageDraw.Draw(cell)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(0, 255, 255), width=2)
    return cell


def build_sheets(stem: str) -> None:
    entry = load_manifest_entry(stem)
    rng = random.Random(SEED)

    with open(DATASET_DIR / entry["label_file"]) as f:
        labels = json.load(f)
    annotations = labels["annotations"]
    elk_size = entry.get("est_elk_size_px") or 20.0
    elk_size = max(5.0, min(60.0, elk_size))
    crop_size = max(MIN_CROP, int(CONTEXT_MULT * elk_size))

    img_path = IMAGES_DIR / entry["image_file"]
    img = Image.open(img_path)
    width, height = img.size

    cats = sample_categories(annotations, rng)
    cats["bg"] = sample_background(annotations, width, height, elk_size, rng)

    items = [
        {"category": name, "x": a["x"], "y": a["y"]}
        for name, anns in cats.items()
        for a in anns
    ]
    rng.shuffle(items)

    out_dir = OUT_DIR / stem
    out_dir.mkdir(parents=True, exist_ok=True)

    key = {
        "stem": stem,
        "elk_size_px": elk_size,
        "crop_size_px": crop_size,
        "cells": {},
    }
    per_sheet = GRID * GRID
    n_sheets = (len(items) + per_sheet - 1) // per_sheet
    for s in range(n_sheets):
        sheet = Image.new("RGB", (GRID * CELL, GRID * CELL), (20, 20, 20))
        draw = ImageDraw.Draw(sheet)
        for i, item in enumerate(items[s * per_sheet : (s + 1) * per_sheet]):
            row, col = divmod(i, GRID)
            cell = make_cell(img, item["x"], item["y"], crop_size, elk_size)
            sheet.paste(cell, (col * CELL, row * CELL))
            cell_id = f"{chr(65 + row)}{col + 1}"
            draw.rectangle(
                [col * CELL, row * CELL, col * CELL + 34, row * CELL + 20], fill=(0, 0, 0)
            )
            draw.text((col * CELL + 4, row * CELL + 4), cell_id, fill=(255, 255, 0))
            key["cells"][f"sheet{s + 1}:{cell_id}"] = {
                "category": item["category"],
                "expected": "elk" if item["category"] in ("tp", "fn") else "not-elk",
                "x": round(item["x"]),
                "y": round(item["y"]),
            }
        sheet_path = out_dir / f"sheet{s + 1}.jpg"
        sheet.save(sheet_path, quality=90)
        print(f"  {sheet_path.relative_to(BASE_DIR)}")

    with open(out_dir / "key.json", "w") as f:
        json.dump(key, f, indent=1)
    counts = {name: len(anns) for name, anns in cats.items()}
    print(f"{stem}: {len(items)} cells over {n_sheets} sheets {counts}, "
          f"crop={crop_size}px, elk~{elk_size:.0f}px")


if __name__ == "__main__":
    stems = sys.argv[1:] or ["DSC01274", "DSC01410", "DSC00465"]
    for stem in stems:
        build_sheets(stem)
