"""Image-first elk census: owned tiles, explicit review, and auditable exports.

No existing annotations or reference counts are read by this script. Run with
the project's Python environment; the propose command additionally needs torch
and ultralytics. See research/independent-census.md for the workflow.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + '\n')


def tiles(width: int, height: int, core: int, halo: int) -> list[dict]:
    if core <= 0 or halo < 0:
        raise ValueError('core must be positive and halo nonnegative')
    return [
        {
            'id': f'r{y // core:02d}c{x // core:02d}',
            'core': [x, y, min(x + core, width), min(y + core, height)],
            'crop': [max(0, x - halo), max(0, y - halo), min(x + core + halo, width), min(y + core + halo, height)],
        }
        for y in range(0, height, core)
        for x in range(0, width, core)
    ]


def contains(rect: list, x: float, y: float) -> bool:
    return rect[0] <= x < rect[2] and rect[1] <= y < rect[3]


def prepare(image_path: Path, output: Path, core: int, halo: int) -> None:
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'manifest.json').exists():
        raise ValueError('Run already exists; choose a new output directory')
    with Image.open(image_path) as image:
        width, height = image.size
        manifest = {
            'image': str(image_path.resolve()),
            'filename': image_path.name,
            'sha256': hashlib.sha256(image_path.read_bytes()).hexdigest(),
            'width': width,
            'height': height,
            'core_size': core,
            'halo': halo,
            'tiles': tiles(width, height, core, halo),
        }
        write_json(output / 'manifest.json', manifest)
        overview = image.convert('RGB')
        overview.thumbnail((1944, 1400))
        scale = overview.width / width
        draw = ImageDraw.Draw(overview)
        for tile in manifest['tiles']:
            box = [round(v * scale) for v in tile['core']]
            draw.rectangle(box, outline='#00ffff', width=1)
            draw.text((box[0] + 3, box[1] + 3), tile['id'], fill='yellow', stroke_width=1, stroke_fill='black')
        overview.save(output / 'grid.jpg', quality=95)
    write_json(
        output / 'review.json',
        {
            'reviewer': '',
            'method': '',
            'tiles': {
                t['id']: {'status': 'pending', 'points': [], 'uncertain': [], 'notes': ''} for t in manifest['tiles']
            },
        },
    )
    print(f'Prepared {len(manifest["tiles"])} tiles -> {output}', flush=True)


def propose(output: Path, weights: Path, conf: float, device: str, batch_size: int) -> None:
    import torch
    from ultralytics import YOLO

    if not 0 < conf <= 1 or batch_size <= 0:
        raise ValueError('confidence must be in (0, 1] and batch size positive')
    if not weights.is_file():
        raise ValueError(f'Model weights not found: {weights}')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    manifest = json.loads((output / 'manifest.json').read_text())
    model = YOLO(str(weights))
    points = []
    image = Image.open(manifest['image']).convert('RGB')
    for start in range(0, len(manifest['tiles']), batch_size):
        batch = manifest['tiles'][start : start + batch_size]
        crops = [image.crop(t['crop']) for t in batch]
        results = model.predict(crops, conf=conf, iou=0.7, imgsz=640, device=device, verbose=False)
        for tile, result in zip(batch, results, strict=True):
            for box, score in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist(), strict=True):
                x = (box[0] + box[2]) / 2 + tile['crop'][0]
                y = (box[1] + box[3]) / 2 + tile['crop'][1]
                if contains(tile['core'], x, y):
                    points.append(
                        {
                            'id': len(points) + 1,
                            'x': round(x, 2),
                            'y': round(y, 2),
                            'confidence': round(score, 4),
                            'tile': tile['id'],
                            'bbox': [round(v + tile['crop'][i % 2], 2) for i, v in enumerate(box)],
                        }
                    )
        print(
            f'{min(start + batch_size, len(manifest["tiles"]))}/{len(manifest["tiles"])} tiles; '
            f'{len(points)} proposals',
            flush=True,
        )
    write_json(
        output / 'proposals.json',
        {
            'weights': str(weights.resolve()),
            'weights_sha256': hashlib.sha256(weights.read_bytes()).hexdigest(),
            'confidence_threshold': conf,
            'device': device,
            'points': points,
        },
    )


def consolidate(output: Path, fraction: float = 0.28) -> None:
    """Group near-coincident proposals for review, retaining all raw evidence.

    This is NOT an animal count or a correctness guarantee. Inspect merged
    members and sweep unmarked pixels: even a small distance can merge neighbors.
    """
    if not 0 < fraction < 1:
        raise ValueError('fraction must be in (0, 1)')
    proposals = json.loads((output / 'proposals.json').read_text())['points']
    kept = []
    for original in sorted(proposals, key=lambda p: -p['confidence']):
        p = dict(original)
        w, h = p['bbox'][2] - p['bbox'][0], p['bbox'][3] - p['bbox'][1]
        for k in kept:
            kw, kh = k['bbox'][2] - k['bbox'][0], k['bbox'][3] - k['bbox'][1]
            if math.hypot(p['x'] - k['x'], p['y'] - k['y']) < fraction * min(w, h, kw, kh):
                k['raw_ids'].append(p['id'])
                break
        else:
            p['raw_id'] = p['id']
            p['raw_ids'] = [p['id']]
            kept.append(p)
    kept.sort(key=lambda p: (p['y'], p['x']))
    for i, p in enumerate(kept, 1):
        p['id'] = i
    write_json(output / 'candidates.json', {'fraction': fraction, 'points': kept})
    print(f'{len(proposals)} raw proposals -> {len(kept)} review candidates')


def render(output: Path, tile_ids: list[str], source: str, scale: float) -> None:
    manifest = json.loads((output / 'manifest.json').read_text())
    image = Image.open(manifest['image']).convert('RGB')
    points = []
    if scale <= 0 or not math.isfinite(scale):
        raise ValueError('scale must be finite and positive')
    if source in ('proposals', 'candidates'):
        points = json.loads((output / f'{source}.json').read_text())['points']
    elif source == 'review':
        review = json.loads((output / 'review.json').read_text())
        points = [
            dict(x=p[0], y=p[1], id=f'{tid}:{i + 1}')
            for tid, t in review['tiles'].items()
            for i, p in enumerate(t['points'])
        ]
    dest = output / source
    dest.mkdir(exist_ok=True)
    requested = set(tile_ids)
    known = {t['id'] for t in manifest['tiles']}
    if requested - known:
        raise ValueError(f'Unknown tiles: {requested - known}')
    for tile in manifest['tiles']:
        if requested and tile['id'] not in requested:
            continue
        x0, y0, x1, y1 = tile['crop']
        crop = image.crop(tile['crop']).resize((round((x1 - x0) * scale), round((y1 - y0) * scale)))
        draw = ImageDraw.Draw(crop)
        draw.rectangle(
            [(tile['core'][i] - (x0 if i % 2 == 0 else y0)) * scale for i in range(4)], outline='cyan', width=2
        )
        for x in range(math.ceil(x0 / 100) * 100, x1, 100):
            draw.text(((x - x0) * scale + 2, 2), str(x), fill='yellow', stroke_width=1, stroke_fill='black')
        for y in range(math.ceil(y0 / 100) * 100, y1, 100):
            draw.text((2, (y - y0) * scale + 2), str(y), fill='yellow', stroke_width=1, stroke_fill='black')
        for p in points:
            if contains(tile['crop'], p['x'], p['y']):
                x, y = (p['x'] - x0) * scale, (p['y'] - y0) * scale
                draw.ellipse((x - 7, y - 7, x + 7, y + 7), outline='#00ff40', width=2)
                draw.text((x + 8, y - 12), str(p['id']), fill='yellow', stroke_width=1, stroke_fill='black')
        crop.save(dest / f'{tile["id"]}.jpg', quality=96)
    print(f'Rendered -> {dest}', flush=True)


def finalize(output: Path) -> dict:
    manifest = json.loads((output / 'manifest.json').read_text())
    review = json.loads((output / 'review.json').read_text())
    expected = {t['id'] for t in manifest['tiles']}
    if set(review['tiles']) != expected:
        raise ValueError('Review tiles do not match manifest')
    if not review['reviewer'].strip() or not review['method'].strip():
        raise ValueError('Reviewer and method are required')
    if hashlib.sha256(Path(manifest['image']).read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('Source image has changed')
    pending = [tid for tid, t in review['tiles'].items() if t['status'] != 'reviewed']
    if pending:
        raise ValueError(f'{len(pending)} unreviewed tiles: {pending}')
    points, uncertain = [], []
    for tile in manifest['tiles']:
        decision = review['tiles'][tile['id']]
        for key, target in [('points', points), ('uncertain', uncertain)]:
            for p in decision[key]:
                if len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p):
                    raise ValueError(f'Invalid point in {tile["id"]}: {p}')
                if not contains(tile['core'], *p):
                    raise ValueError(f'Point outside owning core {tile["id"]}: {p}')
                target.append({'x': p[0], 'y': p[1], 'tile': tile['id']})
    coordinates = [(p['x'], p['y']) for p in points + uncertain]
    if len(set(coordinates)) != len(coordinates):
        raise ValueError('Duplicate point coordinates')
    summary = {
        'filename': manifest['filename'],
        'image_sha256': manifest['sha256'],
        'visible_count': len(points),
        'possible_additional': len(uncertain),
        'count_interval': [len(points), len(points) + len(uncertain)],
        'interval_meaning': 'Definite plus recorded possible animals; not a statistical confidence interval.',
        'reviewer': review['reviewer'],
        'method': review['method'],
        'coverage': 'all tiles reviewed',
        'accuracy_certified': False,
        'limitation': 'An image audit is not independent ground truth or evidence of accuracy on other images.',
    }
    write_json(output / 'result.json', {**summary, 'points': points, 'uncertain': uncertain})
    annotations = [
        {
            'id': i + 1,
            'x': p['x'],
            'y': p['y'],
            'bbox': None,
            'source': 'image-audit',
            'label': 'unclassified elk',
            'category': 'unclassified',
            'state': 'auto-detected',
            'reviewStatus': 'unconfirmed',
            'detection_confidence': None,
            'classification_confidence': None,
        }
        for i, p in enumerate(points)
    ]
    write_json(
        output / 'annotations.json',
        {
            'version': 1,
            'image': {'filename': manifest['filename'], 'width': manifest['width'], 'height': manifest['height']},
            'annotations': annotations,
        },
    )
    image = Image.open(manifest['image']).convert('RGB')
    draw = ImageDraw.Draw(image)
    for p in annotations:
        x, y = p['x'], p['y']
        draw.ellipse((x - 8, y - 8, x + 8, y + 8), outline='#00ff40', width=2)
        draw.text((x + 9, y - 13), str(p['id']), fill='yellow', stroke_width=1, stroke_fill='black')
    for i, p in enumerate(uncertain, 1):
        x, y = p['x'], p['y']
        draw.ellipse((x - 10, y - 10, x + 10, y + 10), outline='orange', width=2)
        draw.text((x + 11, y - 13), f'U{i}', fill='orange', stroke_width=1, stroke_fill='black')
    image.save(output / 'annotated.jpg', quality=96)
    print(json.dumps(summary, indent=2))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare')
    prep.add_argument('image', type=Path)
    prep.add_argument('output', type=Path)
    prep.add_argument('--core', type=int, default=400)
    prep.add_argument('--halo', type=int, default=120)
    prop = commands.add_parser('propose')
    prop.add_argument('output', type=Path)
    prop.add_argument('--weights', type=Path, required=True)
    prop.add_argument('--conf', type=float, default=0.05)
    prop.add_argument('--device', default='auto')
    prop.add_argument('--batch', type=int, default=8)
    group = commands.add_parser('consolidate')
    group.add_argument('output', type=Path)
    group.add_argument('--fraction', type=float, default=0.28)
    rend = commands.add_parser('render')
    rend.add_argument('output', type=Path)
    rend.add_argument('--tiles', nargs='*', default=[])
    rend.add_argument('--source', choices=['blind', 'proposals', 'candidates', 'review'], default='blind')
    rend.add_argument('--scale', type=float, default=1.5)
    finish = commands.add_parser('finalize')
    finish.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.image, args.output, args.core, args.halo)
    elif args.command == 'propose':
        propose(args.output, args.weights, args.conf, args.device, args.batch)
    elif args.command == 'consolidate':
        consolidate(args.output, args.fraction)
    elif args.command == 'render':
        render(args.output, args.tiles, args.source, args.scale)
    else:
        finalize(args.output)


if __name__ == '__main__':
    main()
