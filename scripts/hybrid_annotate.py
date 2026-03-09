"""Hybrid annotation pipeline: SAHI detection + patch generation with markers.

Generates patches with SAHI detection markers overlaid so a visual reviewer
can identify false positives and missed elk.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


def run_sahi_detections(image_path, model_path, conf=0.05, tile_size=640, overlap=0.2):
    """Run SAHI+YOLO and return filtered animal detections."""
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction

    ANIMAL_IDS = {16, 17, 18, 19, 20, 21, 22, 23, 24, 25}

    model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=str(model_path),
        confidence_threshold=conf,
        device="mps",
    )

    result = get_sliced_prediction(
        str(image_path), model,
        slice_height=tile_size, slice_width=tile_size,
        overlap_height_ratio=overlap, overlap_width_ratio=overlap,
        verbose=0,
    )

    detections = []
    for pred in result.object_prediction_list:
        if pred.category.id in ANIMAL_IDS:
            bbox = pred.bbox
            cx = (bbox.minx + bbox.maxx) / 2
            cy = (bbox.miny + bbox.maxy) / 2
            detections.append({
                "x": round(cx), "y": round(cy),
                "conf": float(pred.score.value),
                "class": pred.category.name,
            })

    return detections


def nms_points(detections, min_dist=25):
    """De-duplicate nearby detections, keeping highest confidence."""
    if not detections:
        return []
    dets = sorted(detections, key=lambda d: d["conf"], reverse=True)
    kept = []
    for det in dets:
        too_close = False
        for k in kept:
            dx = det["x"] - k["x"]
            dy = det["y"] - k["y"]
            if dx*dx + dy*dy < min_dist * min_dist:
                too_close = True
                break
        if not too_close:
            kept.append(det)
    return kept


def create_annotated_patches(
    image_path, detections, output_dir, grid_cols=6, grid_rows=4, overlap_frac=0.15
):
    """Create patches with detection markers overlaid.

    Each patch shows:
    - Red circles: SAHI detections
    - Detection ID number next to each marker
    - Grid coordinates in corner
    """
    img = cv2.imread(str(image_path))
    h, w = img.shape[:2]
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(image_path).stem.lower()

    step_x = w // grid_cols
    step_y = h // grid_rows
    pad_x = int(step_x * overlap_frac)
    pad_y = int(step_y * overlap_frac)

    patches_meta = []

    for row in range(grid_rows):
        for col in range(grid_cols):
            x0 = max(0, col * step_x - pad_x)
            y0 = max(0, row * step_y - pad_y)
            x1 = min(w, (col + 1) * step_x + pad_x)
            y1 = min(h, (row + 1) * step_y + pad_y)

            patch = img[y0:y1, x0:x1].copy()

            # Draw detections that fall in this patch
            patch_dets = []
            for i, d in enumerate(detections):
                if x0 <= d["x"] <= x1 and y0 <= d["y"] <= y1:
                    px, py = d["x"] - x0, d["y"] - y0
                    cv2.circle(patch, (px, py), 10, (0, 0, 255), 2)
                    cv2.putText(patch, str(i+1), (px + 12, py + 5),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
                    patch_dets.append(i)

            # Label
            label = f"R{row}C{col} ({len(patch_dets)} det)"
            cv2.putText(patch, label, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 3)
            cv2.putText(patch, label, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 1)

            name = f"{stem}_r{row}_c{col}.jpg"
            cv2.imwrite(str(output_dir / name), patch)

            patches_meta.append({
                "name": name, "row": row, "col": col,
                "x_offset": x0, "y_offset": y0,
                "width": x1 - x0, "height": y1 - y0,
                "detection_count": len(patch_dets),
                "detection_indices": patch_dets,
            })

    # Save metadata
    meta = {
        "source": str(image_path),
        "image_width": w, "image_height": h,
        "grid_cols": grid_cols, "grid_rows": grid_rows,
        "total_detections": len(detections),
        "detections": detections,
        "patches": patches_meta,
    }
    meta_path = output_dir / f"{stem}_meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Created {len(patches_meta)} patches in {output_dir}")
    print(f"Total detections: {len(detections)}")

    # Also create full annotated image
    full_img = img.copy()
    for i, d in enumerate(detections):
        cv2.circle(full_img, (d["x"], d["y"]), 8, (0, 0, 255), 2)
    cv2.putText(full_img, f"SAHI: {len(detections)} detections",
               (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
    cv2.imwrite(str(output_dir / f"{stem}_full_sahi.jpg"), full_img)

    return meta


def generate_annotation_file(
    filename: str, width: int, height: int,
    coordinates: list[tuple[int, int]],
    output_path: str | Path,
    source: str = "sahi+manual",
):
    """Generate annotation JSON in the app's import format."""
    annotations = []
    for i, (x, y) in enumerate(coordinates, 1):
        annotations.append({
            "id": i,
            "x": x,
            "y": y,
            "bbox": None,
            "detection_confidence": None,
            "classification_confidence": None,
            "source": source,
            "label": "elk",
            "category": None,
            "state": "auto-detected" if source != "manual" else "manually-added",
        })

    data = {
        "image": {
            "filename": filename,
            "sourceFilename": filename,
            "width": width,
            "height": height,
        },
        "summary": {
            "counted": len(annotations),
            "ignored": 0,
            "bulls": 0,
            "spikes": 0,
        },
        "annotations": annotations,
    }

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Saved {len(annotations)} annotations to {output_path}")
    return data


if __name__ == "__main__":
    import sys

    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"

    img_name = sys.argv[1] if len(sys.argv) > 1 else "IMG_2870.JPG"
    conf = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05

    img_path = img_dir / img_name
    output_dir = base_dir / "storage" / "output" / "hybrid" / img_name.lower().replace('.jpg', '').replace('.jpeg', '')

    print(f"Running SAHI on {img_name} (conf={conf})...")
    detections = run_sahi_detections(img_path, model_path, conf=conf)
    detections = nms_points(detections, min_dist=25)
    print(f"Got {len(detections)} detections after NMS")

    print(f"\nCreating annotated patches...")
    meta = create_annotated_patches(img_path, detections, output_dir)
