"""Count images with several models and save an annotated image per model, for visual review.

For images without a reference (e.g. the duck samples): look at the overlays and compare models.

    .venv/bin/python -m scripts.census_label storage/samples/duck*.png --species ducks --region-size 400 \\
        --models gpt-6-astra:high claude-sonnet-5-5:high

Each model is MODEL:EFFORT, optionally with :nofinal to skip the final review. Claude models run
one image at a time machine-wide (subscription courtesy); the rest run concurrently. Output goes to
storage/output/labels/<image>/<model>.jpg plus a summary.json with counts and costs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from PIL import Image, ImageDraw
from scripts.census_evals import BASE_DIR, Method, count_image

OUT_DIR = BASE_DIR / 'storage' / 'output' / 'labels'


def render(image: Path, points: list[dict], possible: list[dict], title: str, out: Path) -> None:
    with Image.open(image) as im:
        canvas = im.convert('RGB')
    scale = max(1.0, 2400 / max(canvas.size))
    canvas = canvas.resize((round(canvas.width * scale), round(canvas.height * scale)))
    draw = ImageDraw.Draw(canvas)
    r = max(5, round(canvas.width / 400))
    for color, group in (('#00ff40', points), ('orange', possible)):
        for i, p in enumerate(group, 1):
            x, y = p['x'] * scale, p['y'] * scale
            draw.ellipse((x - r, y - r, x + r, y + r), outline=color, width=2)
            label = str(i) if color != 'orange' else f'?{i}'
            draw.text((x + r + 1, y - 2 * r), label, fill=color, stroke_width=2, stroke_fill='black', font_size=2 * r)
    bar = round(canvas.width / 45)
    draw.rectangle((0, 0, canvas.width, bar + 12), fill='black')
    draw.text((10, 6), title, fill='white', font_size=bar)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, quality=92)


async def label(image: Path, spec: str, species: str, region_size: int) -> dict:
    model, effort, *flags = spec.split(':')
    method = Method(region_size=region_size, final_review='nofinal' not in flags)
    output = await count_image(image, model, effort, method, species=species)
    name = spec.replace(':', '-')
    cost = f'${output.cost_usd:.2f}' if output.cost_usd is not None else 'cost n/a'
    status = '' if output.completed else f' INCOMPLETE ({(output.error or "")[:60]})'
    title = (
        f'{image.name} | {model} {effort}{" no-final" if not method.final_review else ""} | '
        f'{len(output.points)} {species} (+{len(output.possible)} possible, orange) | {cost} API-equiv{status}'
    )
    # An incomplete run still shows whatever it recorded, so failures are visible rather than blank.
    points, possible = output.points, output.possible
    if not output.completed:
        ledger_path = next(
            (p / 'ledger.json' for p in (BASE_DIR / 'storage/sandbox/evals').glob(f'*{output.run_id[:8]}')),
            None,
        )
        if ledger_path and ledger_path.exists():
            ledger = json.loads(ledger_path.read_text())
            points = [p for rec in ledger['records'].values() for p in rec['points']]
            possible = [p for rec in ledger['records'].values() for p in rec['uncertain']]
    out = OUT_DIR / image.stem / f'{name}.jpg'
    render(image, points, possible, title, out)
    print(f'{out.relative_to(BASE_DIR)}: {title}', flush=True)
    return dict(
        image=image.name,
        model=spec,
        count=len(output.points),
        possible=len(output.possible),
        completed=output.completed,
        cost_usd=output.cost_usd,
        file=str(out.relative_to(BASE_DIR)),
    )


async def main_async(args: argparse.Namespace) -> None:
    jobs = [label(image, spec, args.species, args.region_size) for spec in args.models for image in args.images]
    results = await asyncio.gather(*jobs)
    summary = OUT_DIR / 'summary.json'
    previous = json.loads(summary.read_text()) if summary.exists() else []
    summary.write_text(json.dumps(previous + list(results), indent=1) + '\n')


def main() -> None:
    import logfire

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--models', nargs='+', required=True, help='MODEL:EFFORT[:nofinal]')
    parser.add_argument('--species', default='elk', help='plural, e.g. ducks')
    parser.add_argument('--region-size', type=int, default=1600)
    args = parser.parse_args()
    args.images = [p.resolve() for p in args.images]
    logfire.configure(send_to_logfire='if-token-present', service_name='elk-census-labels', console=False)
    asyncio.run(main_async(args))


if __name__ == '__main__':
    main()
