"""Blob detection for counting dark animals on light backgrounds (e.g., elk on snow).

Extracted from research/count_elk5.py. This is the "naive" detection approach
that works well for high-contrast aerial scenes.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import logfire
import numpy as np


def detect_dark_blobs(
    image: np.ndarray,
    threshold: int = 140,
    area_min: int = 10,
    area_max: int = 600,
) -> list[dict]:
    """Detect dark blobs on a light background.

    Args:
        image: BGR image array (from cv2.imread or similar).
        threshold: Grayscale threshold. Pixels darker than this become candidates.
            Lower values (130-140) capture only dark bodies, avoiding shadow merging.
            Higher values (155-180) also capture shadows, causing adjacent animals to merge.
        area_min: Minimum blob area in pixels.
        area_max: Maximum blob area in pixels.

    Returns:
        List of dicts with keys: cx, cy, area, mean_intensity — centroid coordinates,
        blob area, and the mean grey level inside the blob contour (measured on the
        blurred image the threshold was applied to, so it is comparable to `threshold`).
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    _, binary = cv2.threshold(blurred, threshold, 255, cv2.THRESH_BINARY_INV)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    blobs = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area_min <= area <= area_max:
            M = cv2.moments(cnt)
            if M['m00'] > 0:
                cx = M['m10'] / M['m00']
                cy = M['m01'] / M['m00']
                blobs.append(
                    {
                        'cx': cx,
                        'cy': cy,
                        'area': area,
                        'mean_intensity': _mean_contour_intensity(blurred, cnt),
                    }
                )

    return blobs


def _mean_contour_intensity(gray: np.ndarray, contour: np.ndarray) -> float:
    """Mean grey level of the pixels enclosed by `contour`.

    Masks only the contour's bounding box rather than the whole frame, so the cost
    stays proportional to blob size instead of image size.
    """
    x, y, bw, bh = cv2.boundingRect(contour)
    mask = np.zeros((bh, bw), dtype=np.uint8)
    cv2.drawContours(mask, [contour], -1, 255, thickness=cv2.FILLED, offset=(-x, -y))
    return float(cv2.mean(gray[y : y + bh, x : x + bw], mask=mask)[0])


def shadow_aware_nms(
    blobs: list[dict],
    min_dist_general: float = 10,
    shadow_dist: float = 15,
    shadow_angle_deg: float = 135,
    perp_threshold: float = 8,
) -> list[dict]:
    """Non-maximum suppression that merges aggressively along shadow direction.

    Shadows in aerial photos cast in a consistent direction. Two blobs close
    together along the shadow axis are likely body+shadow of the same animal.

    Args:
        blobs: List of blob dicts from detect_dark_blobs.
        min_dist_general: Minimum distance to merge any two blobs.
        shadow_dist: Maximum distance along shadow direction to merge.
        shadow_angle_deg: Shadow direction in degrees (135 = lower-right).
        perp_threshold: Maximum perpendicular distance for shadow merging.

    Returns:
        Filtered list of blob dicts.
    """
    if not blobs:
        return []

    pts = np.array([[b['cx'], b['cy']] for b in blobs])
    scores = np.array([b['area'] for b in blobs])

    angle_rad = np.radians(shadow_angle_deg)
    shadow_dir = np.array([np.cos(angle_rad), np.sin(angle_rad)])

    order = scores.argsort()[::-1]
    keep = []

    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        remaining = order[1:]
        if remaining.size == 0:
            break

        diffs = pts[remaining] - pts[i]
        dists = np.sqrt(np.sum(diffs**2, axis=1))

        shadow_proj = np.abs(diffs @ shadow_dir)
        perp_dist = np.sqrt(np.maximum(dists**2 - shadow_proj**2, 0))

        general_mask = dists < min_dist_general
        shadow_mask = (shadow_proj < shadow_dist) & (perp_dist < perp_threshold)
        suppress_mask = general_mask | shadow_mask

        order = remaining[~suppress_mask]

    return [blobs[i] for i in keep]


def estimate_threshold(image: np.ndarray) -> int:
    """Auto-estimate a good threshold based on image brightness.

    For high-contrast snow scenes, we want a threshold that separates
    dark animal bodies from the light background without capturing shadows.

    Returns:
        Estimated threshold value (typically 120-180).
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mean_brightness = gray.mean()
    std_brightness = gray.std()

    # High-contrast snow scenes: bright mean (>160), high std (>40)
    # Lower threshold captures only the darkest bodies
    if mean_brightness > 160 and std_brightness > 40:
        # Snow scene — use conservative threshold
        return 140
    elif mean_brightness > 140:
        # Moderately bright — slightly higher threshold
        return int(mean_brightness * 0.75)
    else:
        # Dark/low-contrast — use Otsu's method to pick the threshold
        otsu_thresh, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return int(otsu_thresh)


# Every blob returned by the pipeline already passed the area and threshold filters,
# so its confidence is floored here rather than being allowed to reach zero.
CONFIDENCE_FLOOR = 0.1


def blob_confidence(area: float, mean_intensity: float, threshold: int, area_max: int) -> float:
    """Deterministic proxy confidence in (0, 1] for a single blob.

    Blob detection produces no learned score, but the review UI's confidence slider
    and histogram need one to be useful. Two cheap signals are averaged:

    - **Size** — `area` against a soft cap of half `area_max`. Speckle noise is small,
      real animals are closer to the calibrated size; anything at or above the soft
      cap scores 1.0.
    - **Darkness** — how far the blob's mean grey level sits below `threshold`. A blob
      that is solid black scores 1.0; one that only just cleared the threshold scores ~0.

    The average is floored at `CONFIDENCE_FLOOR` so that a blob at the minimum area
    never reports 0, and rounded to three decimals to keep the JSON payload compact.
    """
    soft_cap = max(area_max * 0.5, 1.0)
    size_score = min(1.0, area / soft_cap)
    darkness_score = min(1.0, max(0.0, (threshold - mean_intensity) / max(threshold, 1)))
    return round(max(CONFIDENCE_FLOOR, (size_score + darkness_score) / 2), 3)


@logfire.instrument('detect_animals')
def detect_animals(
    image_path: str | Path,
    threshold: int | None = None,
    area_min: int = 10,
    area_max: int = 600,
) -> list[dict]:
    """Run full detection pipeline on an image.

    Args:
        image_path: Path to the image file.
        threshold: Grayscale threshold. If None, auto-estimated from image.
        area_min: Minimum blob area.
        area_max: Maximum blob area.

    Returns:
        List of annotation dicts matching the frontend schema:
        {id, x, y, bbox, detection_confidence, classification_confidence,
         source, label, state}

        `detection_confidence` is the proxy score from `blob_confidence` — a value in
        (0, 1] derived from blob size and darkness, not a learned probability.
    """
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f'Could not read image: {image_path}')

    h, w = image.shape[:2]

    # Scale area thresholds based on image size
    # Base calibration: elk5.jpg is 2200x1650, area_min=10, area_max=600
    base_pixels = 2200 * 1650
    actual_pixels = w * h
    scale = actual_pixels / base_pixels
    scaled_area_min = max(3, int(area_min * scale))
    scaled_area_max = int(area_max * scale)

    if threshold is None:
        threshold = estimate_threshold(image)

    with logfire.span('blob_detection', threshold=threshold, area_min=scaled_area_min, area_max=scaled_area_max):
        blobs = detect_dark_blobs(
            image,
            threshold=threshold,
            area_min=scaled_area_min,
            area_max=scaled_area_max,
        )

    with logfire.span('shadow_aware_nms', blob_count=len(blobs)):
        blobs = shadow_aware_nms(blobs)

    annotations = []
    for i, blob in enumerate(blobs, 1):
        annotations.append(
            {
                'id': i,
                'x': round(blob['cx']),
                'y': round(blob['cy']),
                'bbox': None,
                'detection_confidence': blob_confidence(
                    area=blob['area'],
                    mean_intensity=blob['mean_intensity'],
                    threshold=threshold,
                    area_max=scaled_area_max,
                ),
                'classification_confidence': None,
                'source': 'blob',
                'label': 'elk',
                'state': 'auto-detected',
            }
        )

    return annotations
