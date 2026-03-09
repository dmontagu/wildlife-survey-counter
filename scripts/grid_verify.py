"""Generate grid-overlay verification images with numbered detection markers.

Overlays:
- Numbered detection markers (semi-transparent red circles)
- Coordinate grid with pixel labels
- Makes it easy to reference specific detections for keep/remove decisions
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


def create_grid_overlay(image_path, detections, output_path, grid_step=400):
    """Create verification image with detection markers and coordinate grid."""
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Could not read: {image_path}")

    h, w = img.shape[:2]
    overlay = img.copy()

    # Draw coordinate grid
    for x in range(0, w, grid_step):
        cv2.line(overlay, (x, 0), (x, h), (200, 200, 200), 1)
        cv2.putText(overlay, str(x), (x + 3, 20),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
    for y in range(0, h, grid_step):
        cv2.line(overlay, (0, y), (w, y), (200, 200, 200), 1)
        cv2.putText(overlay, str(y), (3, y + 15),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

    # Blend grid lightly
    img = cv2.addWeighted(overlay, 0.3, img, 0.7, 0)

    # Draw detection markers with numbers
    for i, d in enumerate(detections):
        x, y = d["x"], d["y"]
        # Filled semi-transparent circle
        circle_overlay = img.copy()
        cv2.circle(circle_overlay, (x, y), 12, (0, 0, 255), -1)
        img = cv2.addWeighted(circle_overlay, 0.4, img, 0.6, 0)
        # Circle outline
        cv2.circle(img, (x, y), 12, (0, 0, 255), 2)
        # Number label
        label = str(i + 1)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
        cv2.putText(img, label, (x - tw//2, y + th//2),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 2)
        cv2.putText(img, label, (x - tw//2, y + th//2),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 200), 1)

    # Header
    label = f"{Path(image_path).name}: {len(detections)} detections"
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5,
               (255, 255, 255), 4)
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5,
               (0, 0, 255), 2)

    cv2.imwrite(str(output_path), img)
    print(f"Saved: {output_path}")


def create_zoomed_patches(image_path, detections, output_dir, grid_cols=3, grid_rows=2):
    """Create larger zoomed patches for detailed inspection of dense areas."""
    img = cv2.imread(str(image_path))
    h, w = img.shape[:2]
    output_dir = Path(output_dir)
    stem = Path(image_path).stem.lower()

    step_x = w // grid_cols
    step_y = h // grid_rows
    pad = 50  # Overlap

    for row in range(grid_rows):
        for col in range(grid_cols):
            x0 = max(0, col * step_x - pad)
            y0 = max(0, row * step_y - pad)
            x1 = min(w, (col + 1) * step_x + pad)
            y1 = min(h, (row + 1) * step_y + pad)

            patch = img[y0:y1, x0:x1].copy()

            # Draw detections
            patch_dets = []
            for i, d in enumerate(detections):
                if x0 <= d["x"] <= x1 and y0 <= d["y"] <= y1:
                    px, py = d["x"] - x0, d["y"] - y0
                    cv2.circle(patch, (px, py), 10, (0, 0, 255), 2)
                    label = str(i + 1)
                    cv2.putText(patch, label, (px + 12, py + 5),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                    patch_dets.append(i + 1)

            # Grid reference
            cv2.putText(patch, f"({x0},{y0})-({x1},{y1}) [{len(patch_dets)} det]",
                       (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 3)
            cv2.putText(patch, f"({x0},{y0})-({x1},{y1}) [{len(patch_dets)} det]",
                       (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)

            name = f"{stem}_zoom_r{row}_c{col}.jpg"
            cv2.imwrite(str(output_dir / name), patch)

    print(f"Created {grid_rows * grid_cols} zoomed patches")


def main():
    import sys

    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    output_base = base_dir / "storage" / "output" / "verification"
    output_base.mkdir(parents=True, exist_ok=True)

    targets = sys.argv[1:] if len(sys.argv) > 1 else [
        "IMG_3706.JPG", "IMG_3708.JPG", "IMG_3712.JPG", "IMG_3733.JPG"
    ]

    for img_name in targets:
        img_path = img_dir / img_name
        stem = img_name.lower().replace('.jpg', '').replace('.jpeg', '')
        meta_dir = base_dir / "storage" / "output" / "hybrid" / stem

        # Load SAHI detections
        meta_path = meta_dir / f"{stem}_meta.json"
        with open(meta_path) as f:
            meta = json.load(f)
        detections = meta["detections"]

        print(f"\n--- {img_name} ({len(detections)} detections) ---")

        # Full image with grid
        create_grid_overlay(img_path, detections,
                          output_base / f"{stem}_grid.jpg", grid_step=500)

        # Zoomed patches (3x2 = 6 large patches)
        patch_dir = output_base / stem
        patch_dir.mkdir(parents=True, exist_ok=True)
        create_zoomed_patches(img_path, detections, patch_dir)


if __name__ == "__main__":
    main()
