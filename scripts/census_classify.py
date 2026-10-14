"""Classify counted elk (cow/calf/spike/brow-tined/...) with different models and settings, and compare.

Uses the reference points in research/eval_dataset/ as the animals to classify, so classification
is measured separately from counting. Runs on the ChatGPT subscription through the Codex CLI.
There are no hand-classified references yet: compare models with each other and inspect overlays.

    .venv/bin/python -m scripts.census_classify run DSC01790 "wpt 103" --models gpt-6-astra:high gpt-5.6-sol:high
    .venv/bin/python -m scripts.census_classify compare DSC01790

Each model is MODEL:EFFORT[:bN] (bN = elk per batch, default 12). Output per run: an overlay at
storage/output/classes/<image>/<model>.jpg and the labels + cost in storage/output/classes/results.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

import logfire
from PIL import Image, ImageDraw
from scripts.census_evals import BASE_DIR, DATASET_DIR, INFRA_ERRORS

from wildlife_counter.classify import PROMPT, Classification
from wildlife_counter.counting_codex import codex_exec

OUT_DIR = BASE_DIR / 'storage' / 'output' / 'classes'
WORK_ROOT = BASE_DIR / 'storage' / 'sandbox' / 'classify'
RESULTS = OUT_DIR / 'results.json'
COLORS = {
    'cow': '#3b82f6',
    'calf': '#22d3ee',
    'unclassified-antlerless': '#a78bfa',
    'spike': '#f59e0b',
    'brow-tined': '#ef4444',
    'bull': '#f97316',
    'unclassified': '#9ca3af',
}


async def classify_once(stem: str, model: str, effort: str, batch_size: int) -> dict[str, Any]:
    ref = json.loads((DATASET_DIR / f'{stem}.json').read_text())
    run_id = uuid.uuid4().hex
    work_dir = (WORK_ROOT / f'{stem}-{model}-{effort}-b{batch_size}-{run_id[:8]}').resolve()
    c = Classification(
        BASE_DIR / ref['image']['path'],
        work_dir,
        ref['image']['width'],
        ref['image']['height'],
        [dict(x=p['x'], y=p['y']) for p in ref['points']],
        ref['animal_size_px'],
        batch_size,
    )
    c.write_source()
    run: dict[str, Any] = dict(id=run_id, model=model, reasoning_effort=effort, usage={}, estimated_cost_usd=None)

    async def on_event(_: dict):
        pass

    started = time.monotonic()
    attrs: dict[str, Any] = {
        'image': stem,
        'model': model,
        'effort': effort,
        'batch_size': batch_size,
        'animals': len(c.points),
        'gen_ai.system': 'openai',
        'gen_ai.request.model': model,
    }
    with logfire.span('classify {image} with {model} ({effort}, batch {batch_size})', **attrs) as span:
        try:
            code = await codex_exec(
                run, work_dir, PROMPT, model, effort, 'wildlife_counter.classify_mcp', 'classify', on_event
            )
            if code and not run.get('error'):
                run['error'] = f'Codex exited with code {code}'
        except Exception as exc:
            run['error'] = str(exc)
        c.load()
        usage = run.get('usage') or {}
        span.set_attributes(
            {
                'gen_ai.usage.input_tokens': usage.get('input_tokens', 0),
                'gen_ai.usage.output_tokens': usage.get('output_tokens', 0),
                'completed': c.submitted,
                'tool_calls': run.get('tool_calls', 0),
            }
        )
        if run.get('estimated_cost_usd') is not None:
            span.set_attribute('operation.cost', run['estimated_cost_usd'])
    labels = {str(k): v['cls'] for k, v in c.labels.items()}
    return dict(
        image=stem,
        model=model,
        effort=effort,
        batch_size=batch_size,
        run_id=run_id,
        completed=c.submitted,
        animals=len(c.points),
        labels=labels,
        by_class=dict(Counter(labels.values())),
        cost_usd=run.get('estimated_cost_usd'),
        usage=usage,
        tool_calls=run.get('tool_calls', 0),
        seconds=round(time.monotonic() - started),
        error=None if c.submitted else run.get('error') or run.get('last_update'),
        summary=c.summary,
    )


async def classify(stem: str, spec: str, retries: int = 2) -> dict[str, Any]:
    model, effort, *rest = spec.split(':')
    batch_size = int(rest[0][1:]) if rest else 12
    result = await classify_once(stem, model, effort, batch_size)
    for _ in range(retries):
        infra = not result['completed'] and any(e in str(result['error']) for e in INFRA_ERRORS)
        if not infra:
            break
        result = await classify_once(stem, model, effort, batch_size)
    render(result)
    print(
        f'{stem} {spec}: {result["by_class"]} ${result["cost_usd"]} {result["seconds"]}s'
        f'{"" if result["completed"] else " INCOMPLETE: " + str(result["error"])[:100]}',
        flush=True,
    )
    return result


def render(result: dict) -> Path:
    ref = json.loads((DATASET_DIR / f'{result["image"]}.json').read_text())
    with Image.open(BASE_DIR / ref['image']['path']) as im:
        canvas = im.convert('RGB')
    scale = 2600 / canvas.width
    canvas = canvas.resize((2600, round(canvas.height * scale)), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(canvas)
    r = max(6, min(20, round(0.45 * ref['animal_size_px'] * scale)))
    for i, p in enumerate(ref['points'], 1):
        color = COLORS.get(result['labels'].get(str(i), ''), 'white')
        x, y = p['x'] * scale, p['y'] * scale
        draw.ellipse((x - r, y - r, x + r, y + r), outline=color, width=max(3, r // 3))
    counts = ', '.join(f'{k} {v}' for k, v in sorted(result['by_class'].items(), key=lambda kv: -kv[1]))
    cost = f'${result["cost_usd"]:.2f}' if result['cost_usd'] is not None else 'cost n/a'
    title = f'{result["image"]} | {result["model"]} {result["effort"]} b{result["batch_size"]} | {counts} | {cost}'
    legend = '   '.join(f'{k}' for k in COLORS)
    bar = 92
    out_im = Image.new('RGB', (canvas.width, canvas.height + bar), 'black')
    out_im.paste(canvas, (0, bar))
    d = ImageDraw.Draw(out_im)
    d.text((12, 6), title, fill='white', font_size=32)
    x = 12
    for k, color in COLORS.items():
        d.ellipse((x, 56, x + 22, 78), outline=color, width=4)
        d.text((x + 30, 52), k, fill=color, font_size=26)
        x += 60 + 15 * len(k)
    _ = legend
    out = OUT_DIR / result['image'] / f'{result["model"]}-{result["effort"]}-b{result["batch_size"]}.jpg'
    out.parent.mkdir(parents=True, exist_ok=True)
    out_im.save(out, quality=90)
    return out


async def run(args: argparse.Namespace) -> None:
    sem = asyncio.Semaphore(args.concurrency)

    async def job(stem: str, spec: str):
        async with sem:
            return await classify(stem, spec)

    results = await asyncio.gather(*(job(s, m) for m in args.models for s in args.images))
    previous = json.loads(RESULTS.read_text()) if RESULTS.exists() else []
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps(previous + list(results), indent=1) + '\n')


def compare(images: list[str]) -> None:
    results = [r for r in json.loads(RESULTS.read_text()) if r['completed'] and (not images or r['image'] in images)]
    by_image: dict[str, list[dict]] = {}
    for r in results:
        by_image.setdefault(r['image'], []).append(r)
    for image, rs in sorted(by_image.items()):
        print(f'\n== {image} ({rs[0]["animals"]} elk)')
        for r in rs:
            name = f'{r["model"]} {r["effort"]} b{r["batch_size"]}'
            cost = f'${r["cost_usd"]:.2f}' if r['cost_usd'] is not None else 'n/a'
            print(f'  {name:34} {cost:>7} {r["seconds"]:>5}s  {dict(sorted(r["by_class"].items()))}')
        base = next((r for r in rs if r['model'] == 'gpt-6-astra' and r['effort'] == 'high'), None)
        if base:
            for r in rs:
                if r is base:
                    continue
                same = sum(r['labels'].get(k) == v for k, v in base['labels'].items())
                name = f'{r["model"]} {r["effort"]} b{r["batch_size"]}'
                print(f'  agreement {name} vs astra high: {same / len(base["labels"]):.0%}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    r = sub.add_parser('run')
    r.add_argument('images', nargs='+')
    r.add_argument('--models', nargs='+', required=True, help='MODEL:EFFORT[:bN]')
    r.add_argument('--concurrency', type=int, default=4)
    c = sub.add_parser('compare')
    c.add_argument('images', nargs='*')
    args = parser.parse_args()
    if args.command == 'compare':
        compare(args.images)
        return
    logfire.configure(send_to_logfire='if-token-present', service_name='elk-classify', console=False)
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
