"""Count elk in elk5.jpg using HerdNet via PytorchWildlife.

HerdNet is a point-based CNN designed for counting ungulates in aerial imagery.
Pre-trained on African ungulates (buffalo, elephant, kob, topi, warthog, waterbuck).
Not trained on elk, so this tests zero-shot transfer.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

IMAGE_PATH = Path('data/elk5.jpg')
OUTPUT_DIR = Path('output/elk5')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def main():
    # Import here to avoid slow import at module level
    from PytorchWildlife.models import detection as pw_detection

    print('Loading HerdNet (general model)...')
    print('(Weights will auto-download from Zenodo on first run)')
    model = pw_detection.HerdNet(device='cpu', version='general')

    print(f'\nModel loaded. Classes: {model.CLASS_NAMES}')
    print(f'Num classes (incl background): {model.num_classes}')

    print(f'\nRunning detection on {IMAGE_PATH}...')
    results = model.single_image_detection(
        img=str(IMAGE_PATH),
        det_conf_thres=0.1,  # Lower thresholds to see more
        clf_conf_thres=0.1,
    )

    detections = results['detections']
    print(f'\nDetections: {len(detections)}')

    if len(detections) > 0:
        print(f'Confidence range: {detections.confidence.min():.3f} - {detections.confidence.max():.3f}')
        print(f'Class IDs found: {set(detections.class_id.tolist())}')
        print(f'Labels: {results["labels"][:10]}...')  # First 10

        # Extract centroids from the fake bboxes
        centroids_x = (detections.xyxy[:, 0] + detections.xyxy[:, 2]) / 2
        centroids_y = (detections.xyxy[:, 1] + detections.xyxy[:, 3]) / 2

        # Annotate image
        img = Image.open(IMAGE_PATH).convert('RGB')
        draw = ImageDraw.Draw(img)

        try:
            font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 10)
        except Exception:
            font = ImageFont.load_default()

        for i, (cx, cy, conf) in enumerate(zip(centroids_x, centroids_y, detections.confidence)):
            r = 4
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill='cyan', outline='white')
            draw.text((cx + r + 1, cy - r), f'{i + 1}', fill='yellow', font=font)

        output_path = OUTPUT_DIR / 'elk5_herdnet.jpg'
        img.save(output_path, quality=95)
        print(f'\nAnnotated image saved: {output_path}')
    else:
        print('No detections found.')

    # Also try with even lower thresholds
    print('\n--- Trying with very low thresholds (0.01) ---')
    results_low = model.single_image_detection(
        img=str(IMAGE_PATH),
        det_conf_thres=0.01,
        clf_conf_thres=0.01,
    )
    print(f'Detections at 0.01 threshold: {len(results_low["detections"])}')

    # And try the ennedi model too
    print('\n--- Trying Ennedi model ---')
    model_ennedi = pw_detection.HerdNet(device='cpu', version='ennedi')
    print(f'Ennedi classes: {model_ennedi.CLASS_NAMES}')
    results_ennedi = model_ennedi.single_image_detection(
        img=str(IMAGE_PATH),
        det_conf_thres=0.1,
        clf_conf_thres=0.1,
    )
    print(f'Ennedi detections: {len(results_ennedi["detections"])}')

    print('\n(Ground truth estimate: ~473 elk)')


if __name__ == '__main__':
    main()
