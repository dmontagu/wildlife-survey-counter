"""Logfire evals for the spatial census: accuracy and cost of each model/effort vs a frozen reference.

Ground truth lives in research/eval_dataset/<stem>.json. It comes from the hand-checked image
audits in research/census_reviews/ where they exist, otherwise from a completed gpt-6-astra census.
It is fallible: astra-derived references measure agreement with astra, not verified accuracy.

    # Freeze references: audits, completed astra runs from a local census DB, plus fresh astra runs
    .venv/bin/python -m scripts.census_evals build --db storage/local-census-test.db --count DSC01116 IMG_3154

    # One experiment per model/effort; results appear under Evals in Logfire
    .venv/bin/python -m scripts.census_evals run --model gpt-5.6-luna --effort high

Every count runs through the Codex CLI on the ChatGPT subscription (no API spend). Costs are
standard short-context API equivalents of the reported token usage, not charges.

Scores: count error (signed, absolute, %) on the final number, and localization via one-to-one
Hungarian matching of predicted to reference points within `match_radius_px` (half an animal):
precision, recall and F1. Placing the right number of points in the wrong places scores ~0 F1.
Predictions within the radius of a reference *possible* animal are neutral, neither hit nor miss.
A run that never completes its review delivers nothing in the app, so it scores as zero points.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import logfire
import numpy as np
from PIL import Image
from pydantic import BaseModel
from pydantic_evals import Case, Dataset
from pydantic_evals.dataset import increment_eval_metric, set_eval_attribute
from pydantic_evals.evaluators import EvaluationReason, Evaluator, EvaluatorContext
from scipy.optimize import linear_sum_assignment

from wildlife_counter.counting_agent import Census
from wildlife_counter.counting_codex import run_codex

BASE_DIR = Path(__file__).resolve().parent.parent
IMAGES_DIR = BASE_DIR / 'data' / 'elk_images_from_fwp'
DATASET_DIR = BASE_DIR / 'research' / 'eval_dataset'
AUDITS_DIR = BASE_DIR / 'research' / 'census_reviews'
MANIFEST = BASE_DIR / 'data' / 'dataset' / 'manifest.json'
CALIBRATION = BASE_DIR / 'data' / 'dataset' / 'calibration.json'
WORK_ROOT = BASE_DIR / 'storage' / 'sandbox' / 'evals'
REFERENCE_MODEL = 'gpt-6-astra'


# --- Scoring -------------------------------------------------------------------------------------


def match_points(pred: list[dict], ref: list[dict], radius: float) -> list[tuple[int, int]]:
    """One-to-one assignment minimizing total distance; pairs farther than `radius` don't match."""
    if not pred or not ref:
        return []
    p = np.array([[a['x'], a['y']] for a in pred], dtype=float)
    g = np.array([[a['x'], a['y']] for a in ref], dtype=float)
    distances = np.linalg.norm(p[:, None] - g[None, :], axis=2)
    rows, cols = linear_sum_assignment(np.where(distances <= radius, distances, radius * (len(pred) + len(ref) + 1)))
    return [(int(i), int(j)) for i, j in zip(rows, cols, strict=True) if distances[i, j] <= radius]


def localization(pred: list[dict], ref: list[dict], possible: list[dict], radius: float) -> dict[str, float]:
    matched = match_points(pred, ref, radius)
    hit = {i for i, _ in matched}
    leftover = [a for i, a in enumerate(pred) if i not in hit]
    neutral = {i for i, _ in match_points(leftover, possible, radius)}
    false_pos = len(leftover) - len(neutral)
    tp = len(matched)
    precision = tp / (tp + false_pos) if tp + false_pos else (1.0 if not ref else 0.0)
    recall = tp / len(ref) if ref else (1.0 if not false_pos else 0.0)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return dict(
        precision=precision,
        recall=recall,
        f1=f1,
        matched=tp,
        false_positives=false_pos,
        missed=len(ref) - tp,
        neutral_possible=len(neutral),
    )


# --- Running one census headlessly ---------------------------------------------------------------


class CountInput(BaseModel):
    image: str  # path relative to the repo root
    sha256: str
    width: int
    height: int


class Reference(BaseModel):
    points: list[dict[str, float]]
    possible: list[dict[str, Any]]
    match_radius_px: float


class CountOutput(BaseModel):
    completed: bool
    points: list[dict[str, float]]
    possible: list[dict[str, Any]]
    cost_usd: float | None
    input_tokens: int
    cached_tokens: int
    output_tokens: int
    tool_calls: int
    error: str | None
    run_id: str
    summary: str


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def count_image(image: Path, model: str, effort: str) -> CountOutput:
    with Image.open(image) as im:
        width, height = im.size
    run_id = uuid.uuid4().hex
    work_dir = (WORK_ROOT / f'{image.stem}-{model}-{effort}-{run_id[:8]}').resolve()
    census = Census(image.resolve(), work_dir, width, height)
    run: dict[str, Any] = dict(
        id=run_id,
        image_filename=image.name,
        model=model,
        runner='codex',
        reasoning_effort=effort,
        usage={},
        estimated_cost_usd=None,
    )

    async def persist(_: dict):
        pass

    try:
        await run_codex(run, census, persist)
    except Exception as exc:
        run['error'] = str(exc)
    points, possible = census.output() if census.submitted else ([], [])
    usage = run.get('usage') or {}
    (work_dir / 'run.json').write_text(json.dumps(run, indent=2, default=str))
    return CountOutput(
        completed=census.submitted,
        points=[dict(x=p['x'], y=p['y']) for p in points],
        possible=[dict(x=p['x'], y=p['y'], reason=p.get('reason', '')) for p in possible],
        cost_usd=run.get('estimated_cost_usd'),
        input_tokens=usage.get('input_tokens', 0),
        cached_tokens=usage.get('cache_read_tokens', 0),
        output_tokens=usage.get('output_tokens', 0),
        tool_calls=run.get('tool_calls', 0),
        error=run.get('error') if not census.submitted else None,
        run_id=run_id,
        summary=census.summary,
    )


# --- Evaluators ----------------------------------------------------------------------------------


@dataclass
class CountAccuracy(Evaluator[CountInput, CountOutput, dict]):
    tolerance_pct: float = 5.0

    def evaluate(self, ctx: EvaluatorContext[CountInput, CountOutput, dict]) -> dict:
        assert ctx.expected_output is not None
        ref = Reference.model_validate(ctx.expected_output)
        expected, got = len(ref.points), len(ctx.output.points)
        error_pct = 100 * abs(got - expected) / expected if expected else (0.0 if not got else 100.0)
        return {
            'count_error': got - expected,
            'count_abs_error_pct': error_pct,
            f'count_within_{self.tolerance_pct:g}pct': EvaluationReason(
                value=error_pct <= self.tolerance_pct, reason=f'counted {got}, reference {expected}'
            ),
        }


@dataclass
class Localization(Evaluator[CountInput, CountOutput, dict]):
    def evaluate(self, ctx: EvaluatorContext[CountInput, CountOutput, dict]) -> dict:
        assert ctx.expected_output is not None
        ref = Reference.model_validate(ctx.expected_output)
        scores = localization(ctx.output.points, ref.points, ref.possible, ref.match_radius_px)
        return {
            'precision': scores['precision'],
            'recall': scores['recall'],
            'f1': scores['f1'],
            'false_positives': scores['false_positives'],
            'missed': scores['missed'],
        }


@dataclass
class Completed(Evaluator[CountInput, CountOutput, dict]):
    def evaluate(self, ctx: EvaluatorContext[CountInput, CountOutput, dict]) -> EvaluationReason:
        return EvaluationReason(value=ctx.output.completed, reason=ctx.output.error or 'review finished')


# --- Dataset -------------------------------------------------------------------------------------


def load_dataset(names: list[str] | None = None) -> Dataset[CountInput, CountOutput, dict]:
    cases = []
    for path in sorted(DATASET_DIR.glob('*.json')):
        if names and path.stem not in names:
            continue
        data = json.loads(path.read_text())
        image = data['image']
        cases.append(
            Case(
                name=path.stem,
                inputs=CountInput(
                    image=image['path'], sha256=image['sha256'], width=image['width'], height=image['height']
                ),
                expected_output=Reference(
                    points=data['points'], possible=data['possible'], match_radius_px=data['match_radius_px']
                ).model_dump(),
                metadata=dict(
                    reference_source=data['source'],
                    reference_count=len(data['points']),
                    reference_possible=len(data['possible']),
                    human_label_count=data.get('human_label_count'),
                    animal_size_px=data['animal_size_px'],
                    match_radius_px=data['match_radius_px'],
                ),
            )
        )
    if not cases:
        raise SystemExit(f'No reference files found in {DATASET_DIR}; run `build` first.')
    return Dataset(
        name='elk-census',
        cases=cases,  # pyright: ignore[reportArgumentType]
        evaluators=[Completed(), CountAccuracy(), Localization()],
    )


def make_task(model: str, effort: str):
    async def census_task(inputs: CountInput) -> CountOutput:
        image = BASE_DIR / inputs.image
        if sha256(image) != inputs.sha256:
            raise ValueError(f'{image} does not match the reference hash')
        output = await count_image(image, model, effort)
        if output.cost_usd is not None:
            increment_eval_metric('cost_usd', output.cost_usd)
        increment_eval_metric('input_tokens', output.input_tokens)
        increment_eval_metric('cached_tokens', output.cached_tokens)
        increment_eval_metric('output_tokens', output.output_tokens)
        increment_eval_metric('tool_calls', output.tool_calls)
        set_eval_attribute('count', len(output.points))
        set_eval_attribute('possible', len(output.possible))
        set_eval_attribute('work_dir_run_id', output.run_id)
        return output

    return census_task


# --- Building references -------------------------------------------------------------------------


def animal_size(stem: str, audit: dict | None) -> float:
    """Audited size when present; otherwise the median detector box width from calibration."""
    if audit and audit['audit'].get('animal_size_px'):
        return float(audit['audit']['animal_size_px'])
    calibration = json.loads(CALIBRATION.read_text()).get(stem, {})
    size = calibration.get('elk_px') or calibration.get('nn_estimate')
    if not size:
        raise SystemExit(f'No animal size known for {stem}; pass one with --size {stem}=PX')
    return float(size)


def human_counts() -> dict[str, int]:
    if not MANIFEST.exists():
        return {}
    return {e['stem']: e['kept'] for e in json.loads(MANIFEST.read_text())['images'] if e['tier'] == 'reviewed'}


def write_reference(
    image: Path, source: str, points: list[dict], possible: list[dict], reference: dict, size: float
) -> Path:
    with Image.open(image) as im:
        width, height = im.size
    out = DATASET_DIR / f'{image.stem}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'version': 1,
        'image': {
            'path': str(image.relative_to(BASE_DIR)),
            'filename': image.name,
            'sha256': sha256(image),
            'width': width,
            'height': height,
        },
        'source': source,
        'reference': reference,
        'animal_size_px': size,
        'match_radius_px': round(max(8.0, size / 2), 1),
        'human_label_count': human_counts().get(image.stem),
        'points': [dict(x=round(p['x'], 1), y=round(p['y'], 1)) for p in points],
        'possible': [dict(x=round(p['x'], 1), y=round(p['y'], 1), reason=p.get('reason', '')) for p in possible],
        'limitation': 'Fallible reference: agreement with it is not independently verified accuracy.',
    }
    out.write_text(json.dumps(data, indent=1) + '\n')
    return out


def find_image(stem_or_name: str) -> Path:
    matches = [p for p in IMAGES_DIR.iterdir() if p.stem == stem_or_name or p.name == stem_or_name]
    if len(matches) != 1:
        raise SystemExit(f'Cannot find a unique image for {stem_or_name!r} in {IMAGES_DIR}')
    return matches[0]


async def build(args: argparse.Namespace) -> None:
    sizes = dict(s.split('=') for s in args.size)
    written: set[str] = set()
    for audit_path in sorted(AUDITS_DIR.glob('*.json')):
        audit = json.loads(audit_path.read_text())
        image = find_image(audit['image']['filename'])
        if sha256(image) != audit['audit']['image_sha256']:
            print(f'skip {audit_path.name}: source hash differs')
            continue
        points = [a for a in audit['annotations'] if a.get('state') != 'rejected']
        out = write_reference(
            image,
            'audit',
            points,
            audit['audit'].get('uncertain', []),
            {'reviewer': audit['audit']['reviewer'], 'file': str(audit_path.relative_to(BASE_DIR))},
            float(sizes.get(image.stem) or animal_size(image.stem, audit)),
        )
        written.add(image.stem)
        print(f'{out.name}: audit, {len(points)} elk')

    if args.db:
        with sqlite3.connect(args.db) as db:
            rows = [json.loads(r[0]) for r in db.execute('SELECT payload FROM census_runs')]
        latest: dict[str, dict] = {}
        for run in sorted(rows, key=lambda r: r.get('completed_at') or ''):
            if run['status'] == 'complete' and run['model'].split(':')[-1] == REFERENCE_MODEL:
                latest[Path(run['image_filename']).stem] = run
        for stem, run in sorted(latest.items()):
            if stem in written:
                continue
            image = find_image(run['image_filename'])
            if sha256(image) != run['image_sha256']:
                print(f'skip run {run["id"]}: source hash differs')
                continue
            out = write_reference(
                image,
                f'{REFERENCE_MODEL} census',
                run['annotations'],
                run['uncertain'],
                {'run_id': run['id'], 'model': run['model'], 'estimated_cost_usd': run.get('estimated_cost_usd')},
                float(sizes.get(stem) or animal_size(stem, None)),
            )
            written.add(stem)
            print(f'{out.name}: astra run {run["id"][:8]}, {len(run["annotations"])} elk')

    semaphore = asyncio.Semaphore(args.concurrency)

    async def fresh(name: str):
        image = find_image(name)
        async with semaphore:
            print(f'counting {image.name} with {REFERENCE_MODEL} ({args.effort})...')
            started = time.monotonic()
            output = await count_image(image, REFERENCE_MODEL, args.effort)
        if not output.completed:
            print(f'{image.name}: FAILED ({output.error}); no reference written')
            return
        out = write_reference(
            image,
            f'{REFERENCE_MODEL} census',
            output.points,
            output.possible,
            {
                'run_id': output.run_id,
                'model': REFERENCE_MODEL,
                'reasoning_effort': args.effort,
                'estimated_cost_usd': output.cost_usd,
                'duration_s': round(time.monotonic() - started),
                'created_at': datetime.now(UTC).isoformat(),
            },
            float(sizes.get(image.stem) or animal_size(image.stem, None)),
        )
        print(f'{out.name}: astra, {len(output.points)} elk, ${output.cost_usd} API-equivalent')

    with logfire.span('build census eval references'):
        await asyncio.gather(*(fresh(name) for name in args.count if Path(name).stem not in written))


async def run(args: argparse.Namespace) -> None:
    dataset = load_dataset(args.cases or None)
    name = args.name or f'{args.model} ({args.effort})'
    report = await dataset.evaluate(
        make_task(args.model, args.effort),
        name=name,
        max_concurrency=args.concurrency,
        metadata=dict(model=args.model, reasoning_effort=args.effort, runner='codex'),
    )
    report.print(include_input=False, include_output=False, include_durations=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build', help='freeze reference point sets into research/eval_dataset/')
    b.add_argument('--db', type=Path, help='census SQLite DB with completed astra runs to reuse')
    b.add_argument('--count', nargs='*', default=[], help='images to count fresh with astra')
    b.add_argument('--effort', default='high')
    b.add_argument('--concurrency', type=int, default=3)
    b.add_argument('--size', nargs='*', default=[], help='override animal size: STEM=PX')
    r = sub.add_parser('run', help='run one experiment (model + effort) over the dataset')
    r.add_argument('--model', required=True)
    r.add_argument('--effort', default='high', choices=['minimal', 'low', 'medium', 'high', 'xhigh'])
    r.add_argument('--concurrency', type=int, default=3)
    r.add_argument('--cases', nargs='*', help='limit to these image stems')
    r.add_argument('--name', help='experiment name (default: "MODEL (EFFORT)")')
    args = parser.parse_args()

    logfire.configure(send_to_logfire='if-token-present', service_name='elk-census-evals', console=False)
    asyncio.run(build(args) if args.command == 'build' else run(args))


if __name__ == '__main__':
    main()
