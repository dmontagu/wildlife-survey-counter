"""Count elk in elk5.jpg using blob detection for tiny/distant animals on snow."""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

IMAGE_PATH = Path('data/elk5.jpg')
OUTPUT_DIR = Path('output/elk5')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def detect_dark_blobs(image_path, threshold=155, area_min=15, area_max=600):
    """Detect dark blobs (elk) on light background (snow) using thresholding."""
    img = cv2.imread(str(image_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    _, binary = cv2.threshold(blurred, threshold, 255, cv2.THRESH_BINARY_INV)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    cv2.imwrite(str(OUTPUT_DIR / 'binary_mask.jpg'), binary)

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    centroids = []
    areas = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area_min <= area <= area_max:
            M = cv2.moments(cnt)
            if M['m00'] > 0:
                cx = M['m10'] / M['m00']
                cy = M['m01'] / M['m00']
                centroids.append((cx, cy))
                areas.append(area)

    if areas:
        areas_arr = np.array(areas)
        print(f'Blob detection: {len(centroids)} blobs (threshold={threshold}, area=[{area_min},{area_max}])')
        print(
            f'  Area stats: min={areas_arr.min():.0f}, median={np.median(areas_arr):.0f}, '
            f'mean={np.mean(areas_arr):.0f}, max={areas_arr.max():.0f}'
        )
    return centroids, areas


def shadow_aware_nms(centroids, areas, min_dist_general=12, shadow_dist=18, shadow_angle_deg=135):
    """NMS that merges more aggressively along the shadow direction.

    Shadows cast to the lower-right in this image, so two blobs that are
    close together along that axis are likely body+shadow of the same elk.
    """
    if not centroids:
        return []

    pts = np.array(centroids)
    scores = np.array(areas)
    # Shadow direction unit vector (from body to shadow tip)
    angle_rad = np.radians(shadow_angle_deg)
    shadow_dir = np.array([np.cos(angle_rad), np.sin(angle_rad)])

    order = scores.argsort()[::-1]
    keep = []

    while order.size > 0:
        i = order[0]
        keep.append(i)
        remaining = order[1:]
        if remaining.size == 0:
            break

        diffs = pts[remaining] - pts[i]
        dists = np.sqrt(np.sum(diffs**2, axis=1))

        # Project displacement onto shadow direction
        shadow_proj = np.abs(diffs @ shadow_dir)
        # Perpendicular distance
        perp_dist = np.sqrt(np.maximum(dists**2 - shadow_proj**2, 0))

        # Suppress if:
        # 1. Within general min_dist (catches all nearby duplicates)
        # 2. OR aligned with shadow direction and close enough
        general_mask = dists < min_dist_general
        shadow_mask = (shadow_proj < shadow_dist) & (perp_dist < 8)
        suppress_mask = general_mask | shadow_mask

        order = remaining[~suppress_mask]

    return keep


def annotate_image(image_path, centroids, output_path):
    """Draw numbered clickpoints on the image."""
    img = Image.open(image_path).convert('RGB')
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 10)
    except Exception:
        font = ImageFont.load_default()

    for i, (cx, cy) in enumerate(centroids, 1):
        r = 4
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill='red', outline='white')
        draw.text((cx + r + 1, cy - r), str(i), fill='yellow', font=font)

    img.save(output_path)
    print(f'Annotated image saved: {output_path}')
    return img


def generate_grid_crops(image_path, rows=3, cols=3, zoom=2):
    """Generate grid crops at zoom level for verification."""
    img = Image.open(image_path).convert('RGB')
    w, h = img.size
    cell_w = w // cols
    cell_h = h // rows

    crop_dir = OUTPUT_DIR / 'crops'
    crop_dir.mkdir(exist_ok=True)

    for r in range(rows):
        for c in range(cols):
            x1 = c * cell_w
            y1 = r * cell_h
            x2 = min(x1 + cell_w, w)
            y2 = min(y1 + cell_h, h)
            crop = img.crop((x1, y1, x2, y2))
            crop = crop.resize((crop.width * zoom, crop.height * zoom), Image.LANCZOS)
            crop.save(crop_dir / f'crop_r{r}_c{c}.jpg')

    print(f'Grid crops saved to {crop_dir}')


def main():
    print(f'Processing {IMAGE_PATH}')
    print('=' * 60)

    # Blob detection: dark elk on light snow
    # threshold=140 captures only the darkest body pixels, avoiding shadow merging
    centroids, areas = detect_dark_blobs(
        IMAGE_PATH,
        threshold=140,
        area_min=10,
        area_max=600,
    )

    # Shadow-aware NMS: merge body+shadow pairs while preserving individual elk
    if centroids:
        keep = shadow_aware_nms(
            centroids,
            areas,
            min_dist_general=10,
            shadow_dist=15,
            shadow_angle_deg=135,  # lower-right direction
        )
        final_centroids = [centroids[i] for i in keep]
        print(f'After shadow-aware NMS: {len(final_centroids)} elk')
    else:
        final_centroids = []
        print('No detections!')

    print('=' * 60)
    print(f'FINAL COUNT: {len(final_centroids)} elk')
    print('=' * 60)

    # Annotate and save
    annotated_path = OUTPUT_DIR / 'elk5_annotated.jpg'
    annotate_image(IMAGE_PATH, final_centroids, annotated_path)

    # Grid crops for verification
    generate_grid_crops(annotated_path, rows=3, cols=3, zoom=2)

    print('\nDone! Check output/elk5/ for results.')


if __name__ == '__main__':
    main()
