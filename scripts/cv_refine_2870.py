"""Cross-validation: produce refined annotations for IMG_2870 and score against GT.

Visual inspection identified missed elk in these areas:
- R2C1: Dense cluster upper-left (~6 missed)
- R2C2: Upper area scattered (~4 missed)
- R2C3: Center gap area (~3 missed)
- R2C4: A few tight pairs (~3 missed)
- R1C2: 1 isolated elk lower-center
- R1C4: 1-2 above main cluster

Also identified ~1-2 potential FPs to remove.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment


def match_and_score(detections, gt_coords, max_dist=30.0):
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


def main():
    base_dir = Path(__file__).parent.parent
    meta_path = base_dir / "storage" / "output" / "hybrid" / "img_2870" / "img_2870_meta.json"
    anno_path = base_dir / "data" / "exported_annotations" / "many_annotations_unified.json"
    img_path = base_dir / "data" / "elk_images_from_fwp" / "IMG_2870.JPG"

    # Load SAHI detections
    with open(meta_path) as f:
        meta = json.load(f)
    sahi_coords = [(d["x"], d["y"]) for d in meta["detections"]]

    # Load GT
    with open(anno_path) as f:
        data = json.load(f)
    gt_coords = None
    for img_data in data["images"]:
        if img_data["image"]["filename"].lower() == "img_2870.jpg":
            if img_data["summary"]["counted"] > 0:
                gt_coords = [(a["x"], a["y"]) for a in img_data["annotations"]]
                break

    print(f"SAHI detections: {len(sahi_coords)}")
    print(f"Ground truth: {len(gt_coords)}")

    # Score SAHI alone
    for max_d in [30, 50]:
        tp, fp, fn, prec, rec, f1 = match_and_score(sahi_coords, gt_coords, max_d)
        print(f"\nSAHI only (max_dist={max_d}):")
        print(f"  TP={tp}, FP={fp}, FN={fn}")
        print(f"  Precision={prec:.3f}, Recall={rec:.3f}, F1={f1:.3f}")

    # Visual corrections based on patch inspection:
    # Additions: elk I identified as missed during patch review
    # Coordinates estimated from patch positions + visual location within patch
    visual_additions = [
        # R2C1 dense cluster (offset 551, 1199) - elk lying close together
        (640, 1480),   # Upper-left of cluster
        (680, 1510),   # Adjacent
        (620, 1540),   # Below first
        (700, 1460),   # Top of cluster
        (660, 1570),   # Bottom of cluster
        (740, 1490),   # Right side of cluster

        # R2C2 upper area (offset 1199, 1199) - scattered misses
        (1380, 1280),  # Upper portion
        (1520, 1320),  # Upper-right
        (1280, 1350),  # Upper-left
        (1450, 1400),  # Mid area

        # R2C3 center gap (offset 1847, 1199) - elk between detected ones
        (2150, 1500),
        (2050, 1550),
        (2250, 1480),

        # R2C4 tight pairs (offset 2495, 1199)
        (2750, 1450),
        (2850, 1520),
        (2700, 1580),

        # R1C2 isolated elk (offset 1199, 551)
        (1550, 1050),
    ]

    # Removals: detection indices that appear to be FPs
    # (from visual inspection, almost all SAHI points look correct)
    # Not removing any for now - precision is already very high

    # Combine SAHI + visual additions
    refined_coords = list(sahi_coords) + visual_additions

    # De-duplicate (remove visual additions too close to existing SAHI points)
    final_coords = list(sahi_coords)
    for ax, ay in visual_additions:
        too_close = False
        for sx, sy in final_coords:
            if (ax - sx)**2 + (ay - sy)**2 < 25**2:
                too_close = True
                break
        if not too_close:
            final_coords.append((ax, ay))

    print(f"\nVisual additions attempted: {len(visual_additions)}")
    print(f"Additions kept (not duplicates): {len(final_coords) - len(sahi_coords)}")
    print(f"Final count: {len(final_coords)}")

    # Score refined
    for max_d in [30, 50]:
        tp, fp, fn, prec, rec, f1 = match_and_score(final_coords, gt_coords, max_d)
        print(f"\nRefined (max_dist={max_d}):")
        print(f"  TP={tp}, FP={fp}, FN={fn}")
        print(f"  Precision={prec:.3f}, Recall={rec:.3f}, F1={f1:.3f}")

    # Generate verification image
    img = cv2.imread(str(img_path))
    # Draw SAHI points in green
    for x, y in sahi_coords:
        cv2.circle(img, (x, y), 6, (0, 255, 0), 2)
    # Draw visual additions in cyan
    for x, y in final_coords[len(sahi_coords):]:
        cv2.circle(img, (x, y), 8, (255, 255, 0), 2)
    label = f"SAHI={len(sahi_coords)} + Visual={len(final_coords)-len(sahi_coords)} = {len(final_coords)} (GT={len(gt_coords)})"
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 4)
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)

    out_path = base_dir / "storage" / "output" / "cross_validation" / "cv_img_2870_refined.jpg"
    cv2.imwrite(str(out_path), img)
    print(f"\nVerification image: {out_path}")


if __name__ == "__main__":
    main()
