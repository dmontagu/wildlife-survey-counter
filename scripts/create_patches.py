"""Create image patches for visual annotation.

Splits an image into a grid of patches, saving each with coordinate metadata.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2


def create_patches(
    image_path: str | Path,
    output_dir: str | Path,
    grid_cols: int = 4,
    grid_rows: int = 3,
    overlap: float = 0.1,
) -> list[dict]:
    """Split image into patches and save them.

    Returns list of patch metadata dicts with:
        name, x_offset, y_offset, width, height, row, col
    """
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Could not read: {image_path}")

    h, w = img.shape[:2]
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    stem = Path(image_path).stem.lower()

    patch_w = int(w / grid_cols * (1 + overlap))
    patch_h = int(h / grid_rows * (1 + overlap))
    step_x = w // grid_cols
    step_y = h // grid_rows

    patches = []
    for row in range(grid_rows):
        for col in range(grid_cols):
            x0 = max(0, col * step_x - int(patch_w * overlap / 2))
            y0 = max(0, row * step_y - int(patch_h * overlap / 2))
            x1 = min(w, x0 + patch_w)
            y1 = min(h, y0 + patch_h)

            patch = img[y0:y1, x0:x1]
            name = f"{stem}_r{row}_c{col}.jpg"
            cv2.imwrite(str(output_dir / name), patch)

            patches.append({
                "name": name,
                "x_offset": x0,
                "y_offset": y0,
                "width": x1 - x0,
                "height": y1 - y0,
                "row": row,
                "col": col,
            })

    # Save metadata
    meta_path = output_dir / f"{stem}_patches.json"
    with open(meta_path, "w") as f:
        json.dump({"source": str(image_path), "patches": patches}, f, indent=2)

    print(f"Created {len(patches)} patches in {output_dir}")
    print(f"Patch size: ~{patch_w}x{patch_h}, step: {step_x}x{step_y}")
    return patches


if __name__ == "__main__":
    import sys
    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"

    images = sys.argv[1:] if len(sys.argv) > 1 else ["IMG_3694.JPG"]

    for img_name in images:
        img_path = img_dir / img_name
        output_dir = base_dir / "storage" / "output" / "patches" / img_name.lower().replace('.jpg', '').replace('.jpeg', '')
        create_patches(img_path, output_dir, grid_cols=4, grid_rows=3)
