"""Cross-validation: test the "low-conf candidates + visual filtering" approach.

Strategy:
1. Run SAHI at very low conf (0.01) → high recall, low precision candidates
2. Also run at normal conf (0.05) → high precision baseline
3. Compare: what's the quality of the "additional" low-conf candidates?
4. If they have decent precision (>50%), visual filtering is worthwhile
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment


def match_and_score(detections, gt_coords, max_dist=50.0):
    if not detections or not gt_coords:
        return 0, len(detections), len(gt_coords), 0, 0, 0
    det = np.array(detections, dtype=float)
    gt = np.array(gt_coords, dtype=float)
    cost = np.zeros((len(det), len(gt)))
    for i in range(len(det)):
        for j in range(len(gt)):
            cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)
    row_ind, col_ind = linear_sum_assignment(cost)
    tp = sum(1 for r, c in zip(row_ind, col_ind) if cost[r, c] <= max_dist)
    fp = len(det) - tp
    fn = len(gt) - tp
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
    return tp, fp, fn, prec, rec, f1


def run_sahi(image_path, model_path, conf=0.05, tile_size=640, overlap=0.2):
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction
    ANIMAL_IDS = {16, 17, 18, 19, 20, 21, 22, 23, 24, 25}
    model = AutoDetectionModel.from_pretrained(
        model_type="yolov8", model_path=str(model_path),
        confidence_threshold=conf, device="mps",
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
    dets = sorted(detections, key=lambda d: d["conf"], reverse=True)
    kept = []
    for det in dets:
        too_close = False
        for k in kept:
            if (det["x"] - k["x"])**2 + (det["y"] - k["y"])**2 < min_dist**2:
                too_close = True
                break
        if not too_close:
            kept.append(det)
    return kept


def main():
    base_dir = Path(__file__).parent.parent
    img_path = base_dir / "data" / "elk_images_from_fwp" / "IMG_2870.JPG"
    model_path = base_dir / "storage" / "models" / "yolov8x.pt"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"

    with open(anno_path) as f:
        data = json.load(f)
    gt_coords = None
    for img_data in data["images"]:
        if img_data["image"]["filename"].lower() == "img_2870.jpg" and img_data["summary"]["counted"] > 0:
            gt_coords = [(a["x"], a["y"]) for a in img_data["annotations"]]
            break

    print(f"GT: {len(gt_coords)} elk\n")

    # Test different confidence tiers
    conf_tiers = [0.01, 0.02, 0.03, 0.05, 0.10]
    results = {}

    for conf in conf_tiers:
        print(f"Running SAHI conf={conf}...")
        dets = run_sahi(img_path, model_path, conf=conf)
        dets = nms_points(dets, min_dist=20)
        coords = [(d["x"], d["y"]) for d in dets]
        tp, fp, fn, prec, rec, f1 = match_and_score(coords, gt_coords, max_dist=50)
        results[conf] = {"dets": dets, "coords": coords, "tp": tp, "fp": fp, "fn": fn,
                         "prec": prec, "rec": rec, "f1": f1}
        print(f"  conf={conf}: det={len(dets)}, TP={tp}, FP={fp}, FN={fn}, "
              f"P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}")

    # Analyze the incremental value of lower confidence detections
    print("\n--- Incremental Analysis ---")
    baseline_coords = set((d["x"], d["y"]) for d in results[0.05]["dets"])
    for conf in [0.01, 0.02, 0.03]:
        all_coords = [(d["x"], d["y"]) for d in results[conf]["dets"]]
        new_coords = [(x, y) for x, y in all_coords if (x, y) not in baseline_coords]

        # How many of these new (lower-conf) points are actual elk?
        if new_coords:
            tp_new, fp_new, fn_new, prec_new, rec_new, _ = match_and_score(
                new_coords, gt_coords, max_dist=50)
            print(f"  Additional @ conf={conf} (vs baseline 0.05): "
                  f"+{len(new_coords)} candidates, {tp_new} are TP, {fp_new} are FP "
                  f"(precision of additions: {prec_new:.3f})")

    # Try the "accept all from higher conf, filter from lower conf" approach
    # Simulate: a perfect visual filter that keeps only TPs from low-conf additions
    print("\n--- Simulated Perfect Visual Filter ---")
    baseline_set = set((d["x"], d["y"]) for d in results[0.05]["dets"])
    for conf in [0.01, 0.02, 0.03]:
        all_dets = results[conf]["dets"]
        all_coords = [(d["x"], d["y"]) for d in all_dets]

        # All baseline points (keep all) + only TP additions from lower conf
        additions = [(x, y) for x, y in all_coords if (x, y) not in baseline_set]
        if additions:
            # Score additions against GT
            det_arr = np.array(additions, dtype=float)
            gt_arr = np.array(gt_coords, dtype=float)
            cost = np.zeros((len(det_arr), len(gt_arr)))
            for i in range(len(det_arr)):
                for j in range(len(gt_arr)):
                    cost[i, j] = np.sqrt((det_arr[i, 0] - gt_arr[j, 0])**2 +
                                         (det_arr[i, 1] - gt_arr[j, 1])**2)
            row_ind, col_ind = linear_sum_assignment(cost)
            tp_additions = [(additions[r], cost[r, c]) for r, c in zip(row_ind, col_ind)
                           if cost[r, c] <= 50]

            filtered_additions = [coord for coord, _ in tp_additions]
            combined = list(baseline_set) + filtered_additions
            tp, fp, fn, prec, rec, f1 = match_and_score(combined, gt_coords, max_dist=50)
            print(f"  Baseline + perfect filter of conf={conf} additions: "
                  f"det={len(combined)}, TP={tp}, FP={fp}, FN={fn}, "
                  f"P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}")


if __name__ == "__main__":
    main()
