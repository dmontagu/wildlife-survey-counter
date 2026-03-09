"""Batch annotation script for new images.

Uses multi-scale SAHI for images where YOLO works, and adaptive blob
detection (with circularity filter) for small-elk-on-snow images.

Usage:
    python scripts/batch_annotate.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.hybrid_annotate import nms_points, run_sahi_detections

BASE_DIR = Path(__file__).parent.parent
IMG_DIR = BASE_DIR / "data" / "elk_images_from_fwp"
MODEL_PATH = BASE_DIR / "storage" / "models" / "yolov8x.pt"
ANNO_DIR = BASE_DIR / "data" / "exported_annotations"

TARGET_IMAGES = [
    "IMG_3762.JPG",
    "IMG_3831.JPG",
    "IMG_3835.JPG",
    "IMG_3911.JPG",
    "IMG_3930.JPG",
    "IMG_3938.JPG",
    "IMG_3955.JPG",
    "wpt 103.JPG",
]


def multi_scale_sahi(image_path, tile_sizes, conf=0.01, overlap=0.3, nms_dist=15):
    """Run SAHI at multiple tile sizes and merge results with NMS."""
    all_dets = []
    for tile_size in tile_sizes:
        print(f"    SAHI at {tile_size}px tiles, conf={conf}...")
        dets = run_sahi_detections(
            image_path, MODEL_PATH, conf=conf, tile_size=tile_size, overlap=overlap
        )
        print(f"    -> {len(dets)} raw detections")
        all_dets.extend(dets)

    print(f"    Total raw (all scales): {len(all_dets)}")
    merged = nms_points(all_dets, min_dist=nms_dist)
    print(f"    After NMS (dist={nms_dist}): {len(merged)}")
    return merged


def blob_detect(
    image_path,
    block_size=51,
    c_value=22,
    area_min=20,
    area_max=600,
    split_above=120,
    kernel_size=5,
    morph_iters=1,
    circularity_min=0.3,
    region_mask=None,
):
    """Blob detection with adaptive thresholding + circularity filter."""
    img = cv2.imread(str(image_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    # Adaptive threshold
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, block_size, c_value,
    )

    if region_mask is not None:
        binary = cv2.bitwise_and(binary, region_mask)

    # Morphological opening to remove noise + thin tracks
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=morph_iters)

    # Find contours
    contours, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    detections = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < area_min:
            continue

        # Circularity filter — reject elongated shapes (tracks, terrain lines)
        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue
        circularity = 4 * np.pi * area / (perimeter * perimeter)
        if circularity < circularity_min:
            continue

        # Compute confidence from darkness relative to local background
        blob_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(blob_mask, [cnt], 0, (255,), -1)
        mean_val = cv2.mean(gray, blob_mask)[0]

        x_r, y_r, w_r, h_r = cv2.boundingRect(cnt)
        pad = max(w_r, h_r) * 2
        lx0, ly0 = max(0, x_r - pad), max(0, y_r - pad)
        lx1, ly1 = min(w, x_r + w_r + pad), min(h, y_r + h_r + pad)
        bg_brightness = float(np.median(gray[ly0:ly1, lx0:lx1]))
        confidence = min(1.0, max(0.05, (bg_brightness - mean_val) / 80.0))

        if area > split_above:
            # Large blob: split with distance transform
            local_mask = np.zeros((h_r + 2, w_r + 2), dtype=np.uint8)
            cv2.drawContours(
                local_mask, [cnt - [x_r, y_r]], 0, (255,), -1, offset=(1, 1)
            )
            dist = cv2.distanceTransform(local_mask, cv2.DIST_L2, 5)
            _, max_val, _, _ = cv2.minMaxLoc(dist)
            if max_val > 2:
                _, peaks = cv2.threshold(dist, max_val * 0.4, 255, cv2.THRESH_BINARY)
                peaks = peaks.astype(np.uint8)
                n_labels, labels_map = cv2.connectedComponents(peaks)
                for lbl in range(1, n_labels):
                    pts = np.where(labels_map == lbl)
                    if len(pts[0]) > 0:
                        cy = int(np.mean(pts[0])) + y_r - 1
                        cx = int(np.mean(pts[1])) + x_r - 1
                        detections.append({
                            "x": cx, "y": cy,
                            "conf": round(confidence, 3), "class": "blob",
                        })
            else:
                M = cv2.moments(cnt)
                if M["m00"] > 0:
                    detections.append({
                        "x": int(M["m10"] / M["m00"]),
                        "y": int(M["m01"] / M["m00"]),
                        "conf": round(confidence, 3), "class": "blob",
                    })
        elif area <= area_max:
            M = cv2.moments(cnt)
            if M["m00"] > 0:
                detections.append({
                    "x": int(M["m10"] / M["m00"]),
                    "y": int(M["m01"] / M["m00"]),
                    "conf": round(confidence, 3), "class": "blob",
                })

    return detections


def make_region_mask(image_path, polygon_points):
    """Create a region mask from polygon vertices."""
    img = cv2.imread(str(image_path))
    h, w = img.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [np.array(polygon_points, dtype=np.int32)], (255,))
    return mask


def generate_annotation_json(filename, width, height, detections, output_path, source="sahi+manual"):
    """Generate annotation file in app import format with confidence scores."""
    annotations = []
    for i, d in enumerate(detections, 1):
        annotations.append({
            "id": i,
            "x": d["x"],
            "y": d["y"],
            "bbox": None,
            "detection_confidence": round(d["conf"], 4),
            "classification_confidence": None,
            "source": source,
            "label": "elk",
            "category": None,
            "state": "auto-detected",
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
    return data


# ============================================================================
# Per-image configurations — tuned from visual inspection and parameter sweeps
# ============================================================================

IMAGE_CONFIGS = {
    "IMG_3762.JPG": {
        # ~150-200 tiny dark elk on clean snow. Elk ~5-8px. YOLO fails entirely.
        # Blob detection with C=22, k=5, circularity>0.3 → ~173 blobs
        "method": "blob",
        "blob_params": {
            "c_value": 22, "kernel_size": 5, "morph_iters": 1,
            "area_min": 20, "area_max": 600, "split_above": 100,
            "circularity_min": 0.3,
        },
        "region_polygon": [
            (200, 1000), (600, 900), (1800, 900), (2800, 1000),
            (3500, 1100), (3700, 1500), (3600, 1800),
            (2500, 1900), (800, 1900), (200, 1700),
        ],
    },
    "IMG_3831.JPG": {
        # ~60-80 elk on patchy snow/brush. Small-medium ~15-25px.
        # Multi-scale SAHI at 320+256 with conf=0.01
        "method": "sahi",
        "tile_sizes": [320, 256],
        "conf": 0.01,
        "nms_dist": 12,
    },
    "IMG_3835.JPG": {
        # ~100-200 elk in multiple groups. Small elk on brush/snow.
        "method": "sahi",
        "tile_sizes": [320, 256],
        "conf": 0.01,
        "nms_dist": 12,
    },
    "IMG_3911.JPG": {
        # ~200-300 tiny dark elk on clean snow. Similar to 3762.
        # SAHI gets ~34, blob gets ~298. Merge both.
        "method": "sahi+blob",
        "tile_sizes": [320, 256],
        "conf": 0.01,
        "nms_dist": 10,
        "blob_params": {
            "c_value": 22, "kernel_size": 5, "morph_iters": 1,
            "area_min": 20, "area_max": 600, "split_above": 100,
            "circularity_min": 0.3,
        },
        "region_polygon": [
            (100, 600), (1500, 500), (3000, 600), (3600, 800),
            (3800, 1400), (3200, 2000), (1800, 2200),
            (400, 2100), (100, 1800),
        ],
    },
    "IMG_3930.JPG": {
        # ~80-120 elk in tight herd on snow. Also tracks/disturbance.
        # Use blob with iter=2 to suppress tracks.
        "method": "sahi+blob",
        "tile_sizes": [320, 256],
        "conf": 0.01,
        "nms_dist": 12,
        "blob_params": {
            "c_value": 22, "kernel_size": 5, "morph_iters": 2,
            "area_min": 20, "area_max": 600, "split_above": 100,
            "circularity_min": 0.3,
        },
        "region_polygon": [
            (1000, 700), (2200, 600), (2800, 800),
            (2700, 1600), (2000, 1800), (1000, 1600),
        ],
    },
    "IMG_3938.JPG": {
        # ~30-50 elk in sagebrush. Medium elk, complex background.
        "method": "sahi",
        "tile_sizes": [320, 256],
        "conf": 0.01,
        "nms_dist": 15,
    },
    "IMG_3955.JPG": {
        # ~100-200 elk on grassy/snowy field with road and creek.
        "method": "sahi",
        "tile_sizes": [320, 640],
        "conf": 0.01,
        "nms_dist": 15,
    },
    "wpt 103.JPG": {
        # ~150-200 large elk in juniper/grass. 60MP image.
        "method": "sahi",
        "tile_sizes": [640],
        "conf": 0.01,
        "nms_dist": 30,
    },
}


def process_image(img_name: str):
    """Full pipeline for a single image."""
    img_path = IMG_DIR / img_name
    stem = Path(img_name).stem
    config = IMAGE_CONFIGS[img_name]

    print(f"\n{'=' * 60}")
    print(f"Processing: {img_name} (method: {config['method']})")
    print(f"{'=' * 60}")

    img = cv2.imread(str(img_path))
    h, w = img.shape[:2]
    del img
    print(f"  Dimensions: {w}x{h}")

    all_detections = []

    # SAHI detection
    if "sahi" in config["method"]:
        print("  Running multi-scale SAHI...")
        sahi_dets = multi_scale_sahi(
            img_path,
            tile_sizes=config["tile_sizes"],
            conf=config.get("conf", 0.01),
            nms_dist=config.get("nms_dist", 15),
        )
        print(f"  SAHI result: {len(sahi_dets)} detections")
        all_detections.extend(sahi_dets)

    # Blob detection
    if "blob" in config["method"]:
        print("  Running blob detection...")
        region_mask = None
        if "region_polygon" in config:
            region_mask = make_region_mask(img_path, config["region_polygon"])

        blob_params = config.get("blob_params", {})
        blob_dets = blob_detect(img_path, region_mask=region_mask, **blob_params)
        print(f"  Blob result: {len(blob_dets)} detections")
        all_detections.extend(blob_dets)

    # Final NMS to merge if both methods used
    if "+" in config["method"]:
        before = len(all_detections)
        all_detections = nms_points(all_detections, min_dist=config.get("nms_dist", 15))
        print(f"  Merged SAHI+blob: {before} -> {len(all_detections)}")

    # Generate annotation JSON
    source = "sahi+manual" if "sahi" in config["method"] else "blob+manual"
    anno_path = ANNO_DIR / f"annotations_{stem}.json"
    generate_annotation_json(img_name, w, h, all_detections, anno_path, source=source)
    print(f"  SAVED: {anno_path} ({len(all_detections)} annotations)")

    return len(all_detections)


def main():
    ANNO_DIR.mkdir(parents=True, exist_ok=True)

    results = {}
    for img_name in TARGET_IMAGES:
        try:
            count = process_image(img_name)
            results[img_name] = count
        except Exception as e:
            print(f"  ERROR: {e}")
            import traceback
            traceback.print_exc()
            results[img_name] = f"ERROR: {e}"

    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    for img_name, count in results.items():
        print(f"  {img_name:20s}  {count}")


if __name__ == "__main__":
    main()
