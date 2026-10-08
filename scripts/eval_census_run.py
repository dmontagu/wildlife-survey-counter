"""Compare a saved application run/export with a source-matched, fallible image audit.

Usage: .venv/bin/python scripts/eval_census_run.py RUN.json AUDIT.json --radius 30
Reports spatial disagreements, not just count agreement. Never used by the counter.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment


def compare(run: dict, audit: dict, radius: float) -> dict:
    if radius <= 0 or not np.isfinite(radius):
        raise ValueError('Matching radius must be finite and positive')
    run = run.get('census', run)
    if run['status'] != 'complete':
        raise ValueError('Cannot evaluate an incomplete count')
    if not run.get('image_sha256') or run['image_sha256'] != audit['audit']['image_sha256']:
        raise ValueError('Source image hashes do not match')
    pred = [p for p in run['annotations'] if p.get('state') != 'rejected']
    ref = [p for p in audit['annotations'] if p.get('state') != 'rejected']
    matches = []
    if pred and ref:
        p = np.array([[p['x'], p['y']] for p in pred])
        g = np.array([[p['x'], p['y']] for p in ref])
        distances = np.linalg.norm(p[:, None] - g[None, :], axis=2)
        rows, cols = linear_sum_assignment(
            np.where(distances <= radius, distances, radius * (len(pred) + len(ref) + 1))
        )
        matches = [(int(i), int(j)) for i, j in zip(rows, cols) if distances[i, j] <= radius]
    matched_p, matched_g = {i for i, _ in matches}, {j for _, j in matches}
    return {
        'run_id': run['id'],
        'image': run['image_filename'],
        'radius_px': radius,
        'count': len(pred),
        'audit_count': len(ref),
        'count_difference': len(pred) - len(ref),
        'absolute_count_error_pct': 100 * abs(len(pred) - len(ref)) / len(ref) if ref else None,
        'matched': len(matches),
        'unmatched_predictions': [p for i, p in enumerate(pred) if i not in matched_p],
        'unmatched_audit': [p for j, p in enumerate(ref) if j not in matched_g],
        'possible_additional': [p for p in run['uncertain'] if p.get('decision') == 'pending'],
        'audit_possible_additional': audit['audit'].get('uncertain', []),
        'has_review_decisions': any(p.get('decision', 'pending') != 'pending' for p in run['uncertain']),
        'usage': run['usage'],
        'estimated_cost_usd': run.get('estimated_cost_usd'),
        'cost_basis': run.get('cost_basis'),
        'limitation': (
            'Agreement with a fallible audit, not independently verified accuracy. Inspect spatial disagreements.'
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('audit', type=Path)
    parser.add_argument(
        '--radius', type=float, required=True, help='Animal-scale coordinate tolerance in source pixels'
    )
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = compare(json.loads(args.run.read_text()), json.loads(args.audit.read_text()), args.radius)
    text = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
