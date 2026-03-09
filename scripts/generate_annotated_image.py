"""Generate annotated images with detection markers for visual verification."""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


def draw_detections(image_path, detections, output_path, marker_size=8, color=(0, 0, 255)):
    """Draw detection markers on an image.

    Args:
        image_path: Path to source image
        detections: List of (x, y) tuples
        output_path: Path to save annotated image
        marker_size: Radius of markers
        color: BGR color tuple
    """
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Could not read: {image_path}")

    for x, y in detections:
        # Draw crosshair marker
        cv2.circle(img, (int(x), int(y)), marker_size, color, 2)
        cv2.line(img, (int(x) - marker_size, int(y)), (int(x) + marker_size, int(y)), color, 1)
        cv2.line(img, (int(x), int(y) - marker_size), (int(x), int(y) + marker_size), color, 1)

    # Add count label
    label = f"Count: {len(detections)}"
    cv2.putText(img, label, (30, 60), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 3)

    cv2.imwrite(str(output_path), img)
    print(f"Saved annotated image: {output_path} ({len(detections)} markers)")


def draw_comparison(image_path, gt_coords, det_coords, output_path, max_dist=50):
    """Draw ground truth vs detections with TP/FP/FN coloring."""
    from scipy.optimize import linear_sum_assignment

    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Could not read: {image_path}")

    # Match detections to GT
    if gt_coords and det_coords:
        det = np.array(det_coords)
        gt = np.array(gt_coords)
        cost = np.zeros((len(det), len(gt)))
        for i in range(len(det)):
            for j in range(len(gt)):
                cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)
        row_ind, col_ind = linear_sum_assignment(cost)

        tp_det = set()
        tp_gt = set()
        for r, c in zip(row_ind, col_ind):
            if cost[r, c] <= max_dist:
                tp_det.add(r)
                tp_gt.add(c)

        # Draw FN (missed GT) - yellow circles
        for i, (x, y) in enumerate(gt_coords):
            if i not in tp_gt:
                cv2.circle(img, (int(x), int(y)), 12, (0, 255, 255), 2)

        # Draw TP (correct detections) - green circles
        for i, (x, y) in enumerate(det_coords):
            if i in tp_det:
                cv2.circle(img, (int(x), int(y)), 8, (0, 255, 0), 2)

        # Draw FP (false detections) - red circles
        for i, (x, y) in enumerate(det_coords):
            if i not in tp_det:
                cv2.circle(img, (int(x), int(y)), 8, (0, 0, 255), 2)

        tp = len(tp_det)
        fp = len(det_coords) - tp
        fn = len(gt_coords) - tp
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0
        label = f"GT={len(gt_coords)} Det={len(det_coords)} TP={tp} FP={fp} FN={fn} P={prec:.2f} R={rec:.2f}"
    else:
        label = f"GT={len(gt_coords)} Det={len(det_coords)}"

    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 4)
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)

    cv2.imwrite(str(output_path), img)
    print(f"Saved comparison: {output_path}")
    print(f"  {label}")


def run_sahi_yolo(image_path, model_path, tile_size=640, overlap=0.2, conf=0.05):
    """Run SAHI+YOLO and return animal detection coordinates."""
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction

    ANIMAL_CLASS_IDS = {16, 17, 18, 19, 20, 21, 22, 23, 24, 25}

    detection_model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=str(model_path),
        confidence_threshold=conf,
        device="mps",
    )

    result = get_sliced_prediction(
        str(image_path),
        detection_model,
        slice_height=tile_size,
        slice_width=tile_size,
        overlap_height_ratio=overlap,
        overlap_width_ratio=overlap,
        verbose=0,
    )

    detections = []
    for pred in result.object_prediction_list:
        cls_id = pred.category.id
        if cls_id in ANIMAL_CLASS_IDS:
            bbox = pred.bbox
            cx = (bbox.minx + bbox.maxx) / 2
            cy = (bbox.miny + bbox.maxy) / 2
            detections.append((round(cx), round(cy)))

    return detections


def main():
    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"
    output_dir = base_dir / "storage" / "output" / "annotated"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load GT
    with open(anno_path) as f:
        data = json.load(f)
    gt_by_name = {}
    for img_data in data["images"]:
        fname = img_data["image"]["filename"]
        if img_data["summary"]["counted"] > 0:
            gt_by_name[fname.lower()] = [(a["x"], a["y"]) for a in img_data["annotations"]]

    # Generate comparison for a labeled image (IMG_3694 - YOLO's best)
    for img_name in ["IMG_3694.JPG"]:
        img_path = img_dir / img_name
        gt = gt_by_name.get(img_name.lower().replace('.jpg', '.jpg'), [])
        if not gt:
            gt = gt_by_name.get(img_name.lower(), [])
            if not gt:
                # Try without extension change
                for key in gt_by_name:
                    if key.replace('.jpg', '') == img_name.lower().replace('.jpg', '').replace('.jpeg', ''):
                        gt = gt_by_name[key]
                        break

        print(f"\nProcessing {img_name} (GT: {len(gt)} elk)...")
        detections = run_sahi_yolo(img_path, model_path, tile_size=640, conf=0.05)
        draw_comparison(img_path, gt, detections,
                       output_dir / f"comparison_{img_name.lower().replace('.jpg', '')}.jpg")

    # Generate annotated images for target images
    for img_name in ["IMG_3706.JPG", "IMG_3708.JPG", "IMG_3712.JPG", "IMG_3733.JPG"]:
        img_path = img_dir / img_name
        if not img_path.exists():
            continue
        print(f"\nProcessing {img_name}...")
        detections = run_sahi_yolo(img_path, model_path, tile_size=640, conf=0.05)
        draw_detections(img_path, detections,
                       output_dir / f"sahi_{img_name.lower().replace('.jpg', '')}.jpg")


if __name__ == "__main__":
    main()
