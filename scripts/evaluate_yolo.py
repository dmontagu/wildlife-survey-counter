"""Evaluate YOLOv8x against labeled elk images.

Tests YOLO's ability to detect elk-like animals (uses COCO classes for various animals).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

# COCO class IDs that might detect elk-like animals
# 16=bird, 17=cat, 18=dog, 19=horse, 20=sheep, 21=cow, 22=elephant, 23=bear, 24=zebra, 25=giraffe
ANIMAL_CLASS_IDS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
# Also try just the large animal classes
LARGE_ANIMAL_IDS = [19, 20, 21, 22, 23, 24, 25]  # horse through giraffe


def load_unified_annotations(path: str | Path) -> dict[str, dict]:
    with open(path) as f:
        data = json.load(f)
    result = {}
    for img_data in data["images"]:
        fname = img_data["image"]["filename"]
        if img_data["summary"]["counted"] > 0:
            result[fname.lower()] = img_data
    return result


def match_detections_to_gt(detections, ground_truth, max_dist=30.0):
    if not detections and not ground_truth:
        return 0, 0, 0, 0.0
    if not detections:
        return 0, 0, len(ground_truth), 0.0
    if not ground_truth:
        return 0, len(detections), 0, 0.0

    det = np.array(detections)
    gt = np.array(ground_truth)

    cost = np.zeros((len(det), len(gt)))
    for i in range(len(det)):
        for j in range(len(gt)):
            cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)

    row_ind, col_ind = linear_sum_assignment(cost)
    tp = sum(1 for r, c in zip(row_ind, col_ind) if cost[r, c] <= max_dist)
    fp = len(det) - tp
    fn = len(gt) - tp
    matched_dists = [cost[r, c] for r, c in zip(row_ind, col_ind) if cost[r, c] <= max_dist]
    avg_dist = np.mean(matched_dists) if matched_dists else 0.0
    return tp, fp, fn, float(avg_dist)


def main():
    from ultralytics import YOLO

    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"

    annotations = load_unified_annotations(anno_path)
    print(f"Loaded annotations for {len(annotations)} images")

    model = YOLO(str(model_path))
    print(f"Loaded YOLO model: {model_path.name}\n")

    test_images = [
        "IMG_3318.jpg", "IMG_3607.jpg", "IMG_3694.jpg",
        "IMG_3192.jpg", "IMG_2835.jpg", "IMG_3204.jpg",
    ]
    target_images = ["IMG_3706.JPG", "IMG_3708.JPG", "IMG_3712.JPG", "IMG_3733.JPG"]

    conf_thresholds = [0.01, 0.05, 0.1, 0.25]

    print("=" * 100)
    print("YOLO DETECTION EVALUATION")
    print("=" * 100)

    for img_name in test_images + target_images:
        img_path = img_dir / img_name
        if not img_path.exists():
            img_path = img_dir / img_name.replace('.jpg', '.JPG')
        if not img_path.exists():
            continue

        is_target = img_name in target_images
        gt = []
        gt_count = 0
        if img_name.lower() in annotations:
            gt = [(a["x"], a["y"]) for a in annotations[img_name.lower()]["annotations"]]
            gt_count = len(gt)

        marker = " [TARGET]" if is_target else f" (GT: {gt_count} elk)"
        print(f"\n--- {img_name}{marker} ---")

        for conf in conf_thresholds:
            results = model.predict(str(img_path), conf=conf, verbose=False)
            result = results[0]
            boxes = result.boxes

            # Filter for animal classes
            all_detections = []
            animal_detections = []
            class_counts = {}

            for box in boxes:
                cls_id = int(box.cls[0])
                cls_name = result.names[cls_id]
                conf_val = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

                class_counts[cls_name] = class_counts.get(cls_name, 0) + 1

                if cls_id in ANIMAL_CLASS_IDS:
                    animal_detections.append((round(cx), round(cy)))

                all_detections.append((round(cx), round(cy)))

            if not is_target and gt:
                tp, fp, fn, avg_d = match_detections_to_gt(animal_detections, gt, max_dist=50)
                prec = tp / (tp + fp) if (tp + fp) > 0 else 0
                rec = tp / (tp + fn) if (tp + fn) > 0 else 0
                f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
                print(f"  conf={conf:.2f}: total={len(all_detections)}, animals={len(animal_detections)}, "
                      f"TP={tp}, FP={fp}, FN={fn}, P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}")
            else:
                print(f"  conf={conf:.2f}: total={len(all_detections)}, animals={len(animal_detections)}")

            if conf == 0.1:
                top_classes = sorted(class_counts.items(), key=lambda x: -x[1])[:5]
                if top_classes:
                    cls_str = ", ".join(f"{k}={v}" for k, v in top_classes)
                    print(f"    Top classes @ conf=0.1: {cls_str}")


if __name__ == "__main__":
    main()
