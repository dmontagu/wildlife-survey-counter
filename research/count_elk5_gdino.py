"""Count elk in elk5.jpg using Grounding DINO (zero-shot object detection).

Grounding DINO is the detection backbone of CountGD. This tests whether
zero-shot text-guided detection can find small/distant elk on snow.
"""

from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

IMAGE_PATH = Path('data/elk5.jpg')
OUTPUT_DIR = Path('output/elk5')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

THRESHOLDS = [0.05, 0.10, 0.15, 0.20]
TEXT_PROMPT = 'elk . animal . deer .'

DEVICE = 'mps' if torch.backends.mps.is_available() else 'cpu'


def load_model():
    model_id = 'IDEA-Research/grounding-dino-base'
    print(f'Loading {model_id}...')
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(DEVICE)
    model.eval()
    return processor, model


def detect(processor, model, image, text, threshold):
    """Run Grounding DINO detection on an already-loaded image."""
    w, h = image.size

    inputs = processor(images=image, text=text, return_tensors='pt').to(DEVICE)

    with torch.no_grad():
        outputs = model(**inputs)

    results = processor.post_process_grounded_object_detection(
        outputs,
        input_ids=inputs.input_ids,
        threshold=threshold,
        text_threshold=threshold,
        target_sizes=[(h, w)],
    )[0]

    boxes = results['boxes'].cpu().numpy()
    scores = results['scores'].cpu().numpy()
    labels = results['text_labels']

    return boxes, scores, labels


def nms_by_distance(boxes, scores, min_dist=15):
    """Simple distance-based NMS using box centers."""
    if len(boxes) == 0:
        return []

    centers = np.stack([(boxes[:, 0] + boxes[:, 2]) / 2, (boxes[:, 1] + boxes[:, 3]) / 2], axis=1)
    order = scores.argsort()[::-1]
    keep = []

    while order.size > 0:
        i = order[0]
        keep.append(i)
        remaining = order[1:]
        if remaining.size == 0:
            break
        dists = np.sqrt(np.sum((centers[remaining] - centers[i]) ** 2, axis=1))
        order = remaining[dists >= min_dist]

    return keep


def annotate_image(image_path, boxes, scores, output_path, show_boxes=False):
    """Draw detection results on the image."""
    img = Image.open(image_path).convert('RGB')
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 10)
    except Exception:
        font = ImageFont.load_default()

    for i, (box, _score) in enumerate(zip(boxes, scores)):
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        r = 4
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill='lime', outline='white')
        draw.text((cx + r + 1, cy - r), f'{i + 1}', fill='yellow', font=font)

        if show_boxes:
            draw.rectangle(box.tolist(), outline='lime', width=1)

    img.save(output_path, quality=95)
    print(f'  Annotated image saved: {output_path}')


def main():
    print(f'Processing {IMAGE_PATH}')
    print(f'Device: {DEVICE}')
    print('=' * 60)

    processor, model = load_model()
    image = Image.open(IMAGE_PATH).convert('RGB')
    print(f'Image size: {image.size[0]}x{image.size[1]}')

    for threshold in THRESHOLDS:
        print(f'\nThreshold={threshold}:')
        boxes, scores, labels = detect(processor, model, image, TEXT_PROMPT, threshold)
        print(f'  Raw detections: {len(boxes)}')

        if len(scores) > 0:
            print(f'  Score range: {scores.min():.3f} - {scores.max():.3f}')
            print(f'  Labels: {set(labels)}')

            keep = nms_by_distance(boxes, scores, min_dist=12)
            kept_boxes = boxes[keep]
            kept_scores = scores[keep]
            print(f'  After NMS (min_dist=12): {len(keep)}')

            output_path = OUTPUT_DIR / f'elk5_gdino_t{threshold:.2f}.jpg'
            annotate_image(IMAGE_PATH, kept_boxes, kept_scores, output_path)
        else:
            print('  No detections')

    print('\n' + '=' * 60)
    print('Summary:')
    for threshold in THRESHOLDS:
        boxes, scores, _ = detect(processor, model, image, TEXT_PROMPT, threshold)
        keep = nms_by_distance(boxes, scores, min_dist=12) if len(boxes) > 0 else []
        print(f'  threshold={threshold:.2f}: {len(boxes)} raw → {len(keep)} after NMS')
    print('\n(Ground truth estimate: ~473 elk)')


if __name__ == '__main__':
    main()
