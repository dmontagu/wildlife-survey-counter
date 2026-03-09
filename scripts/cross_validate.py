"""Cross-validate the SAHI+YOLO pipeline on labeled images.

Tests different confidence thresholds to find the best precision/recall tradeoff.
Emphasis: precision > recall (points must be on actual elk).
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
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


def match_detections_to_gt(detections, ground_truth, max_dist=30.0):
    """Match detections to GT. Returns (tp, fp, fn, matched_pairs)."""
    if not detections and not ground_truth:
        return 0, 0, 0, []
    if not detections:
        return 0, 0, len(ground_truth), []
    if not ground_truth:
        return 0, len(detections), 0, []

    det = np.array(detections, dtype=float)
    gt = np.array(ground_truth, dtype=float)
    cost = np.zeros((len(det), len(gt)))
    for i in range(len(det)):
        for j in range(len(gt)):
            cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)
    row_ind, col_ind = linear_sum_assignment(cost)

    tp_pairs = []
    for r, c in zip(row_ind, col_ind):
        if cost[r, c] <= max_dist:
            tp_pairs.append((r, c, cost[r, c]))

    tp = len(tp_pairs)
    fp = len(det) - tp
    fn = len(gt) - tp
    return tp, fp, fn, tp_pairs


def run_sahi(image_path, model_path, tile_size=640, overlap=0.2, conf=0.05):
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
                "bbox_w": bbox.maxx - bbox.minx,
                "bbox_h": bbox.maxy - bbox.miny,
            })

    return detections


def nms_points(detections, min_dist=25):
    """De-duplicate nearby detections, keeping highest confidence."""
    if not detections:
        return []

    # Sort by confidence descending
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


def draw_annotated(image_path, detections, gt_coords, output_path, max_dist=30):
    """Draw detections with TP/FP coloring."""
    img = cv2.imread(str(image_path))

    det_coords = [(d["x"], d["y"]) for d in detections]
    tp, fp, fn, pairs = match_detections_to_gt(det_coords, gt_coords, max_dist)

    tp_det_indices = {p[0] for p in pairs}
    tp_gt_indices = {p[1] for p in pairs}

    # FN = missed GT (yellow)
    for i, (x, y) in enumerate(gt_coords):
        if i not in tp_gt_indices:
            cv2.circle(img, (int(x), int(y)), 14, (0, 255, 255), 2)

    # TP = correct (green)
    for i, d in enumerate(detections):
        if i in tp_det_indices:
            cv2.circle(img, (d["x"], d["y"]), 8, (0, 255, 0), 2)

    # FP = wrong (red)
    for i, d in enumerate(detections):
        if i not in tp_det_indices:
            cv2.circle(img, (d["x"], d["y"]), 8, (0, 0, 255), 2)

    prec = tp / (tp + fp) if (tp + fp) > 0 else 0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
    label = f"GT={len(gt_coords)} Det={len(detections)} TP={tp} FP={fp} FN={fn} P={prec:.2f} R={rec:.2f} F1={f1:.2f}"
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 4)
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 2)

    cv2.imwrite(str(output_path), img)
    print(f"  Saved: {output_path}")
    return tp, fp, fn


def main():
    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"
    output_dir = base_dir / "storage" / "output" / "cross_validation"
    output_dir.mkdir(parents=True, exist_ok=True)

    annotations = load_unified_annotations(anno_path)

    # Test on images similar to targets (moderate range, snow)
    test_images = [
        "IMG_3694.JPG",  # 72 elk, closest to IMG_3706/3708
        "IMG_3157.JPG",  # 197 elk, similar scene type
        "IMG_3192.JPG",  # 180 elk
        "IMG_2870.JPG",  # 159 elk
    ]

    # Test multiple confidence thresholds and NMS distances
    configs = [
        {"conf": 0.05, "nms_dist": 25, "label": "conf05_nms25"},
        {"conf": 0.10, "nms_dist": 25, "label": "conf10_nms25"},
        {"conf": 0.15, "nms_dist": 25, "label": "conf15_nms25"},
        {"conf": 0.20, "nms_dist": 25, "label": "conf20_nms25"},
        {"conf": 0.10, "nms_dist": 15, "label": "conf10_nms15"},
        {"conf": 0.10, "nms_dist": 35, "label": "conf10_nms35"},
    ]

    for max_dist in [30, 50]:
        print(f"\n{'='*100}")
        print(f"CROSS-VALIDATION (match_dist={max_dist}px)")
        print(f"{'='*100}")

        for img_name in test_images:
            img_path = img_dir / img_name
            if not img_path.exists():
                continue

            gt_key = img_name.lower().replace('.jpg', '.jpg')
            if gt_key not in annotations:
                gt_key = img_name.lower()
            if gt_key not in annotations:
                print(f"\n--- {img_name}: NO GT FOUND ---")
                continue

            gt_coords = [(a["x"], a["y"]) for a in annotations[gt_key]["annotations"]]
            print(f"\n--- {img_name} (GT: {len(gt_coords)} elk) ---")

            for cfg in configs:
                detections = run_sahi(img_path, model_path, conf=cfg["conf"])
                detections = nms_points(detections, min_dist=cfg["nms_dist"])
                det_coords = [(d["x"], d["y"]) for d in detections]

                tp, fp, fn, pairs = match_detections_to_gt(det_coords, gt_coords, max_dist)
                prec = tp / (tp + fp) if (tp + fp) > 0 else 0
                rec = tp / (tp + fn) if (tp + fn) > 0 else 0
                f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0

                print(f"  {cfg['label']:>15s}: det={len(detections):4d}, "
                      f"TP={tp:3d}, FP={fp:3d}, FN={fn:3d}, "
                      f"P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}")

                # Save best config comparison images
                if max_dist == 30 and cfg["label"] == "conf10_nms25":
                    out_name = f"cv_{img_name.lower().replace('.jpg', '')}_{cfg['label']}.jpg"
                    draw_annotated(img_path, detections, gt_coords, output_dir / out_name, max_dist)


if __name__ == "__main__":
    main()
