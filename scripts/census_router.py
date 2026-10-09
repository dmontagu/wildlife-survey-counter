"""Route each image to a census strategy by pre-count difficulty, and simulate routing rules offline.

    # 1. Difficulty features from the elk detector only (never the reference): research/eval_router/features.json
    .venv/bin/python -m scripts.census_router features
    # 2. Image x strategy results from local eval runs, scored against the references
    .venv/bin/python -m scripts.census_router matrix
    # 3. Cost vs accuracy of single strategies, an oracle, and threshold rules (with leave-one-out)
    .venv/bin/python -m scripts.census_router simulate

A strategy is model + effort + method, e.g. "gpt-6-astra high no-final". A threshold rule sends
images with feature <= t to a cheap strategy and the rest to an expensive one. Rules are chosen
on all images and also re-scored leave-one-out, so a rule that only fits these images shows it.
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image
from scripts.census_evals import BASE_DIR, DATASET_DIR, INFRA_ERRORS, WORK_ROOT, localization

from wildlife_counter.counting_agent import propose

OUT_DIR = BASE_DIR / 'research' / 'eval_router'
RUN_DIR = re.compile(
    r'(?P<image>.+?)-(?P<model>(?:gpt|claude)-.+?)-(?P<effort>minimal|low|medium|high|xhigh|max)'
    r'(?:-(?P<tiles>\d+)(?P<nofinal>-nofinal)?)?-(?P<id>[0-9a-f]{8})$'
)


def references() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text()) for p in sorted(DATASET_DIR.glob('*.json'))}


def difficulty(image: Path) -> dict:
    with Image.open(image) as im:
        width, height = im.size
    proposals = propose(image, width, height) or []
    confident = [p for p in proposals if p['confidence'] >= 0.25]
    pts = np.array([[p['x'], p['y']] for p in confident]) if confident else np.zeros((0, 2))
    size = float(np.median([p['size'] for p in confident])) if confident else 0.0
    crowded = 0.0
    if len(pts) > 1:
        d = np.linalg.norm(pts[:, None] - pts[None, :], axis=2)
        np.fill_diagonal(d, np.inf)
        crowded = float(np.mean(d.min(axis=1) < 1.5 * size))
    return dict(
        megapixels=round(width * height / 1e6, 1),
        proposals=len(proposals),
        confident=len(confident),
        animal_px=round(size, 1),
        # Small animals relative to the frame are the hard case: many tiny, overlapping targets.
        animal_frac=round(size / max(width, height), 4),
        crowded=round(crowded, 3),
        low_conf_share=round(1 - len(confident) / len(proposals), 3) if proposals else 0.0,
    )


def strategy_label(m: re.Match) -> str:
    label = f'{m["model"]} {m["effort"]}'
    if m['tiles'] and m['tiles'] != '1600':
        label += f' tiles{m["tiles"]}'
    return label + (' no-final' if m['nofinal'] else '')


def matrix() -> dict[str, dict[str, list[dict]]]:
    """{image: {strategy: [run scores]}} for finished eval runs; reference-building runs are excluded."""
    refs = references()
    reference_runs = {r['reference'].get('run_id', '')[:8] for r in refs.values()}
    out: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for run_dir in sorted(WORK_ROOT.iterdir()):
        m = RUN_DIR.match(run_dir.name)
        if not m or m['id'] in reference_runs or m['image'] not in refs:
            continue
        if not (run_dir / 'run.json').exists():
            continue  # stopped before finishing
        run = json.loads((run_dir / 'run.json').read_text())
        ledger = json.loads((run_dir / 'ledger.json').read_text()) if (run_dir / 'ledger.json').exists() else {}
        done = bool(ledger.get('submitted'))
        if not done and any(e in str(run.get('error') or '') for e in INFRA_ERRORS):
            continue  # lost network/provider stream: not a model result, so neither scored nor penalized
        points = [p for rid in ledger.get('regions', {}) for p in ledger['records'].get(rid, {}).get('points', [])]
        ref = refs[m['image']]
        scores = localization(points if done else [], ref['points'], ref['possible'], ref['match_radius_px'])
        count = len(points) if done else 0
        out[m['image']][strategy_label(m)].append(
            dict(
                run=m['id'],
                completed=done,
                count=count,
                reference=len(ref['points']),
                count_error_pct=100 * abs(count - len(ref['points'])) / max(1, len(ref['points'])),
                f1=scores['f1'],
                cost=run.get('estimated_cost_usd'),
            )
        )
    return {k: dict(v) for k, v in out.items()}


def mean_scores(mat: dict) -> dict[str, dict[str, dict]]:
    """{strategy: {image: {f1, cost}}}, averaging repeated runs."""
    per: dict[str, dict[str, dict]] = defaultdict(dict)
    for image, strategies in mat.items():
        for strategy, runs in strategies.items():
            costs = [r['cost'] for r in runs if r['cost'] is not None]
            per[strategy][image] = dict(
                f1=float(np.mean([r['f1'] for r in runs])),
                cost=float(np.mean(costs)) if costs else float('nan'),
                n=len(runs),
            )
    return per


def pareto(rows: list[tuple[str, float, float]]) -> list[tuple[str, float, float]]:
    """(name, cost, f1) rows not beaten on both cost and F1 by another row."""
    return sorted(
        (r for r in rows if not any(o[1] <= r[1] and o[2] >= r[2] and (o[1], o[2]) != (r[1], r[2]) for o in rows)),
        key=lambda r: r[1],
    )


def simulate(min_coverage: int) -> None:
    features = json.loads((OUT_DIR / 'features.json').read_text())
    per = mean_scores(json.loads((OUT_DIR / 'matrix.json').read_text()))
    strategies = sorted(s for s, imgs in per.items() if len(imgs) >= min_coverage)
    images = sorted(set.intersection(*(set(per[s]) for s in strategies)) & set(features)) if strategies else []
    if len(images) < 3:
        raise SystemExit(f'Too few images covered by every strategy with >= {min_coverage} images: {images}')
    print(f'{len(images)} images covered by all of: {", ".join(strategies)}\n')

    def score(choice: dict[str, str]) -> tuple[float, float]:
        return (
            float(np.mean([per[choice[i]][i]['cost'] for i in images])),
            float(np.mean([per[choice[i]][i]['f1'] for i in images])),
        )

    rows = []
    print(f'{"single strategy":44} {"$/img":>7} {"F1":>6} {"min F1":>7}')
    for s in strategies:
        cost, f1 = score({i: s for i in images})
        rows.append((s, cost, f1))
        print(f'{s:44} {cost:7.2f} {f1:6.3f} {min(per[s][i]["f1"] for i in images):7.3f}')

    for target in (0.95, 0.98):
        choice = {}
        for i in images:
            ok = [s for s in strategies if per[s][i]['f1'] >= target]
            choice[i] = min(ok or strategies, key=lambda s: per[s][i]['cost'] if ok else -per[s][i]['f1'])
        cost, f1 = score(choice)
        print(
            f'\noracle: cheapest strategy with F1>={target} per image (routing upper bound): ${cost:.2f}, F1 {f1:.3f}'
        )
        print('  ' + ', '.join(f'{i}->{choice[i]}' for i in images))

    rules = []
    for cheap, dear in itertools.permutations(strategies, 2):
        for feat in next(iter(features.values())):
            for t in sorted({features[i][feat] for i in images}):
                choice = {i: cheap if features[i][feat] <= t else dear for i in images}
                cost, f1 = score(choice)
                rules.append((f'{feat}<={t}: {cheap} else {dear}', cost, f1, cheap, dear, feat, t))
    frontier = pareto([(r[0], r[1], r[2]) for r in rows + [(r[0], r[1], r[2]) for r in rules]])
    print(f'\npareto frontier over single strategies and {len(rules)} threshold rules (in-sample):')
    for name, cost, f1 in frontier:
        print(f'  ${cost:6.2f}  F1 {f1:.3f}  {name}')

    # Leave-one-out: pick the threshold on the other images, apply it to the held-out one.
    print('\nleave-one-out for each frontier rule shape (cheap/dear/feature fixed, threshold re-fit):')
    shapes = {(r[3], r[4], r[5]) for r in rules if r[0] in {f[0] for f in frontier}}
    for cheap, dear, feat in sorted(shapes):
        held = []
        for out in images:
            train = [i for i in images if i != out]
            best = max(
                sorted({features[i][feat] for i in train}),
                key=lambda t: (
                    np.mean([per[cheap if features[i][feat] <= t else dear][i]['f1'] for i in train])
                    - 0.01 * np.mean([per[cheap if features[i][feat] <= t else dear][i]['cost'] for i in train])
                ),
            )
            s = cheap if features[out][feat] <= best else dear
            held.append((per[s][out]['cost'], per[s][out]['f1']))
        print(
            f'  ${np.mean([h[0] for h in held]):6.2f}  F1 {np.mean([h[1] for h in held]):.3f}  {feat}: {cheap} / {dear}'
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('features')
    sub.add_parser('matrix')
    s = sub.add_parser('simulate')
    s.add_argument('--min-coverage', type=int, default=6, help='only strategies run on at least this many images')
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if args.command == 'features':
        path = OUT_DIR / 'features.json'
        feats = json.loads(path.read_text()) if path.exists() else {}
        for stem, ref in references().items():
            if stem not in feats:
                feats[stem] = difficulty(BASE_DIR / ref['image']['path'])
                print(stem, feats[stem])
                path.write_text(json.dumps(feats, indent=1, sort_keys=True) + '\n')
    elif args.command == 'matrix':
        mat = matrix()
        (OUT_DIR / 'matrix.json').write_text(json.dumps(mat, indent=1, sort_keys=True) + '\n')
        for image, strategies in sorted(mat.items()):
            print(
                image, ' | '.join(f'{s}: {np.mean([r["f1"] for r in rs]):.2f}' for s, rs in sorted(strategies.items()))
            )
    else:
        simulate(args.min_coverage)


if __name__ == '__main__':
    main()
