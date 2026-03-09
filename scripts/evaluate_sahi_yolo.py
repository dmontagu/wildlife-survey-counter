"""Evaluate YOLO + SAHI (tiled inference) against labeled elk images."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment


def load_unified_annotations(path):
    with open(path) as f:
        data = json.load(f)
    result = {}
    for img_data in data["images"]:
        fname = img_data["image"]["filename"]
        if img_data["summary"]["counted"] > 0:
            result[fname.lower()] = img_data
    return result


def match_detections_to_gt(detections, ground_truth, max_dist=50.0):
    if not detections and not ground_truth:
        return 0, 0, 0
    if not detections:
        return 0, 0, len(ground_truth)
    if not ground_truth:
        return 0, len(detections), 0

    det = np.array(detections)
    gt = np.array(ground_truth)
    cost = np.zeros((len(det), len(gt)))
    for i in range(len(det)):
        for j in range(len(gt)):
            cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)
    row_ind, col_ind = linear_sum_assignment(cost)
    tp = sum(1 for r, c in zip(row_ind, col_ind) if cost[r, c] <= max_dist)
    return tp, len(det) - tp, len(gt) - tp


def main():
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction

    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"

    annotations = load_unified_annotations(anno_path)

    detection_model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=str(model_path),
        confidence_threshold=0.05,
        device="mps",  # Use Apple Silicon GPU
    )

    # COCO animal class IDs
    ANIMAL_CLASS_IDS = {16, 17, 18, 19, 20, 21, 22, 23, 24, 25}

    test_images = ["IMG_3694.jpg", "IMG_3192.jpg", "IMG_3607.jpg", "IMG_2835.jpg"]
    target_images = ["IMG_3706.JPG", "IMG_3708.JPG", "IMG_3712.JPG", "IMG_3733.JPG"]

    # Different tile sizes to test
    tile_configs = [
        (640, 640, 0.2),
        (800, 800, 0.2),
        (1024, 1024, 0.2),
    ]

    for img_name in test_images + target_images:
        img_path = img_dir / img_name
        if not img_path.exists():
            img_path = img_dir / img_name.replace('.jpg', '.JPG')
        if not img_path.exists():
            continue

        is_target = img_name in target_images
        gt = []
        if img_name.lower() in annotations:
            gt = [(a["x"], a["y"]) for a in annotations[img_name.lower()]["annotations"]]

        marker = " [TARGET]" if is_target else f" (GT: {len(gt)} elk)"
        print(f"\n--- {img_name}{marker} ---")

        for tile_w, tile_h, overlap in tile_configs:
            try:
                result = get_sliced_prediction(
                    str(img_path),
                    detection_model,
                    slice_height=tile_h,
                    slice_width=tile_w,
                    overlap_height_ratio=overlap,
                    overlap_width_ratio=overlap,
                    verbose=0,
                )

                # Filter for animal classes
                animal_detections = []
                class_counts = {}
                for pred in result.object_prediction_list:
                    cls_id = pred.category.id
                    cls_name = pred.category.name
                    bbox = pred.bbox
                    cx = (bbox.minx + bbox.maxx) / 2
                    cy = (bbox.miny + bbox.maxy) / 2
                    class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
                    if cls_id in ANIMAL_CLASS_IDS:
                        animal_detections.append((round(cx), round(cy)))

                total = len(result.object_prediction_list)

                if not is_target and gt:
                    tp, fp, fn = match_detections_to_gt(animal_detections, gt, max_dist=50)
                    prec = tp / (tp + fp) if (tp + fp) > 0 else 0
                    rec = tp / (tp + fn) if (tp + fn) > 0 else 0
                    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
                    print(f"  tile={tile_w}x{tile_h}: total={total}, animals={len(animal_detections)}, "
                          f"TP={tp}, FP={fp}, FN={fn}, P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}")
                else:
                    print(f"  tile={tile_w}x{tile_h}: total={total}, animals={len(animal_detections)}")

                # Show top classes
                top = sorted(class_counts.items(), key=lambda x: -x[1])[:5]
                if top:
                    cls_str = ", ".join(f"{k}={v}" for k, v in top)
                    print(f"    Classes: {cls_str}")

            except Exception as e:
                print(f"  tile={tile_w}x{tile_h}: ERROR: {e}")


if __name__ == "__main__":
    main()
