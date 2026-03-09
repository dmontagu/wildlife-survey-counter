"""Evaluate blob detection and YOLO against labeled images.

Tests detection accuracy using distance-based matching against ground truth annotations.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from wildlife_counter.detect import detect_dark_blobs, shadow_aware_nms, estimate_threshold


def load_unified_annotations(path: str | Path) -> dict[str, dict]:
    """Load unified annotations and return a dict keyed by lowercase filename."""
    with open(path) as f:
        data = json.load(f)

    result = {}
    for img_data in data["images"]:
        fname = img_data["image"]["filename"]
        # Skip entries with 0 annotations (duplicates)
        if img_data["summary"]["counted"] > 0:
            result[fname.lower()] = img_data
    return result


def match_detections_to_gt(
    detections: list[tuple[int, int]],
    ground_truth: list[tuple[int, int]],
    max_dist: float = 30.0
) -> tuple[int, int, int, float]:
    """Match detections to ground truth using Hungarian algorithm.

    Returns: (true_positives, false_positives, false_negatives, avg_distance)
    """
    if not detections and not ground_truth:
        return 0, 0, 0, 0.0
    if not detections:
        return 0, 0, len(ground_truth), 0.0
    if not ground_truth:
        return 0, len(detections), 0, 0.0

    det = np.array(detections)
    gt = np.array(ground_truth)

    # Build cost matrix (distances)
    cost = np.zeros((len(det), len(gt)))
    for i in range(len(det)):
        for j in range(len(gt)):
            cost[i, j] = np.sqrt((det[i, 0] - gt[j, 0])**2 + (det[i, 1] - gt[j, 1])**2)

    # Hungarian matching
    row_ind, col_ind = linear_sum_assignment(cost)

    # Count matches within threshold
    tp = 0
    matched_dists = []
    for r, c in zip(row_ind, col_ind):
        if cost[r, c] <= max_dist:
            tp += 1
            matched_dists.append(cost[r, c])

    fp = len(det) - tp
    fn = len(gt) - tp
    avg_dist = np.mean(matched_dists) if matched_dists else 0.0

    return tp, fp, fn, avg_dist


def run_blob_detection(
    image_path: str | Path,
    threshold: int | None = None,
    area_min: int = 10,
    area_max: int = 600,
    nms: bool = True
) -> list[tuple[int, int]]:
    """Run blob detection and return (x, y) coordinate list."""
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"Could not read: {image_path}")

    h, w = image.shape[:2]
    base_pixels = 2200 * 1650
    actual_pixels = w * h
    scale = actual_pixels / base_pixels
    scaled_min = max(3, int(area_min * scale))
    scaled_max = int(area_max * scale)

    if threshold is None:
        threshold = estimate_threshold(image)

    blobs = detect_dark_blobs(image, threshold=threshold, area_min=scaled_min, area_max=scaled_max)
    if nms:
        blobs = shadow_aware_nms(blobs)

    return [(round(b["cx"]), round(b["cy"])) for b in blobs], threshold


def get_gt_coords(annotations: list[dict]) -> list[tuple[int, int]]:
    """Extract (x, y) coordinates from annotation list."""
    return [(a["x"], a["y"]) for a in annotations]


def compute_metrics(tp, fp, fn):
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    return precision, recall, f1


def analyze_image_characteristics(image_path: str | Path) -> dict:
    """Analyze image characteristics relevant to detection."""
    image = cv2.imread(str(image_path))
    if image is None:
        return {}

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = image.shape[:2]

    return {
        "width": w,
        "height": h,
        "mean_brightness": float(gray.mean()),
        "std_brightness": float(gray.std()),
        "min_brightness": int(gray.min()),
        "max_brightness": int(gray.max()),
        "estimated_threshold": estimate_threshold(image),
    }


def main():
    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"

    annotations = load_unified_annotations(anno_path)
    print(f"Loaded annotations for {len(annotations)} images\n")

    # Test images with annotations
    test_images = [
        "IMG_3318.jpg", "IMG_3607.jpg", "IMG_3694.jpg",
        "IMG_3157.jpg", "IMG_3192.jpg", "IMG_3154.jpg",
        "IMG_2830.jpg", "IMG_2835.jpg", "IMG_2841.jpg", "IMG_2870.jpg",
        "IMG_3204.jpg",
    ]

    # Target images (no annotations)
    target_images = ["IMG_3706.JPG", "IMG_3708.JPG", "IMG_3712.JPG", "IMG_3733.JPG"]

    print("=" * 100)
    print("IMAGE CHARACTERISTICS ANALYSIS")
    print("=" * 100)

    for img_name in test_images + target_images:
        # Try both JPG and jpg
        img_path = img_dir / img_name
        if not img_path.exists():
            img_path = img_dir / img_name.upper()
        if not img_path.exists():
            img_path = img_dir / img_name.replace('.jpg', '.JPG').replace('.jpeg', '.JPEG')
        if not img_path.exists():
            print(f"  {img_name}: NOT FOUND")
            continue

        chars = analyze_image_characteristics(img_path)
        gt_count = 0
        if img_name.lower() in annotations:
            gt_count = annotations[img_name.lower()]["summary"]["counted"]

        marker = " [TARGET]" if img_name in target_images else ""
        print(f"  {img_name}{marker}: {chars['width']}x{chars['height']}, "
              f"brightness={chars['mean_brightness']:.1f}+/-{chars['std_brightness']:.1f}, "
              f"auto_thresh={chars['estimated_threshold']}, "
              f"gt_count={gt_count}")

    print()
    print("=" * 100)
    print("BLOB DETECTION EVALUATION (various thresholds)")
    print("=" * 100)

    thresholds_to_test = [None, 120, 130, 140, 150, 160]
    match_distances = [20, 30, 50]

    results = {}

    for img_name in test_images:
        img_path = img_dir / img_name
        if not img_path.exists():
            img_path = img_dir / img_name.replace('.jpg', '.JPG')
        if not img_path.exists():
            continue

        if img_name.lower() not in annotations:
            continue

        gt = get_gt_coords(annotations[img_name.lower()]["annotations"])
        gt_count = len(gt)

        print(f"\n--- {img_name} (GT: {gt_count} elk) ---")

        img_results = {}
        for thresh in thresholds_to_test:
            try:
                detections, actual_thresh = run_blob_detection(img_path, threshold=thresh)
                thresh_label = f"auto({actual_thresh})" if thresh is None else str(thresh)

                for max_d in match_distances:
                    tp, fp, fn, avg_dist = match_detections_to_gt(detections, gt, max_dist=max_d)
                    prec, rec, f1 = compute_metrics(tp, fp, fn)

                    if max_d == 30:  # Primary metric
                        img_results[thresh_label] = {
                            "detected": len(detections),
                            "tp": tp, "fp": fp, "fn": fn,
                            "precision": prec, "recall": rec, "f1": f1,
                            "avg_dist": avg_dist,
                            "count_error": len(detections) - gt_count
                        }

                    if max_d == 30:
                        print(f"  thresh={thresh_label:>8s}: detected={len(detections):4d}, "
                              f"TP={tp:3d}, FP={fp:3d}, FN={fn:3d}, "
                              f"P={prec:.3f}, R={rec:.3f}, F1={f1:.3f}, "
                              f"avg_dist={avg_dist:.1f}px, count_err={len(detections)-gt_count:+d}")
            except Exception as e:
                print(f"  thresh={thresh}: ERROR: {e}")

        results[img_name] = img_results

    # Summary statistics
    print("\n" + "=" * 100)
    print("SUMMARY: BEST BLOB DETECTION RESULTS PER IMAGE (max_dist=30)")
    print("=" * 100)

    for img_name, img_results in results.items():
        if not img_results:
            continue
        best = max(img_results.items(), key=lambda x: x[1]["f1"])
        r = best[1]
        print(f"  {img_name:25s}: best_thresh={best[0]:>8s}, "
              f"F1={r['f1']:.3f}, P={r['precision']:.3f}, R={r['recall']:.3f}, "
              f"count_err={r['count_error']:+d}")

    # Now run on target images
    print("\n" + "=" * 100)
    print("BLOB DETECTION ON TARGET IMAGES (no ground truth)")
    print("=" * 100)

    for img_name in target_images:
        img_path = img_dir / img_name
        if not img_path.exists():
            continue

        chars = analyze_image_characteristics(img_path)
        print(f"\n--- {img_name} ---")
        print(f"  Characteristics: brightness={chars['mean_brightness']:.1f}+/-{chars['std_brightness']:.1f}")

        for thresh in thresholds_to_test:
            try:
                detections, actual_thresh = run_blob_detection(img_path, threshold=thresh)
                thresh_label = f"auto({actual_thresh})" if thresh is None else str(thresh)
                print(f"  thresh={thresh_label:>8s}: detected={len(detections):4d}")
            except Exception as e:
                print(f"  thresh={thresh}: ERROR: {e}")


if __name__ == "__main__":
    main()
