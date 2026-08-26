"""Evaluate predicted point annotations against ground-truth labels.

Matching: Hungarian assignment on pairwise distances, with matches beyond the
radius discarded. Radius defaults to max(8, 0.75 * est_elk_size_px) from the
dataset manifest, falling back to 20px when the manifest has no estimate.

Metrics per image: TP/FP/FN, precision, recall, F1, count error.
Aggregate: micro P/R/F1, count MAE / MAPE.

Usage:
    # Single comparison (pred file vs dataset ground truth by stem)
    python scripts/eval_annotations.py --pred path/to/pred.json --gt DSC00764

    # Baseline: per-image pipeline exports vs reviewed dataset labels
    python scripts/eval_annotations.py --baseline

Prediction files may be: a dataset label file, a frontend export
({image, annotations}), or a bare JSON list of {x, y} objects.
Only kept annotations (state != rejected) count on either side.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

BASE_DIR = Path(__file__).parent.parent
DATASET_DIR = BASE_DIR / "data" / "dataset"
EXPORTS_DIR = BASE_DIR / "data" / "exported_annotations"
OUT_DIR = BASE_DIR / "storage" / "output" / "evals"

KEPT_STATES = {"auto-detected", "confirmed", "manually-added"}


def load_points(path: Path) -> list[tuple[float, float]]:
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, list):
        anns = data
    else:
        anns = data.get("annotations", [])
    return [
        (a["x"], a["y"])
        for a in anns
        if a.get("state", "auto-detected") in KEPT_STATES or "state" not in a
    ]


def match_points(
    pred: list[tuple[float, float]],
    gt: list[tuple[float, float]],
    radius: float,
) -> tuple[int, int, int]:
    """Return (tp, fp, fn) using optimal assignment within radius."""
    if not pred or not gt:
        return 0, len(pred), len(gt)
    p = np.array(pred, dtype=np.float64)
    g = np.array(gt, dtype=np.float64)
    dists = np.linalg.norm(p[:, None, :] - g[None, :, :], axis=2)
    # Costs beyond radius are made prohibitively large so the assignment
    # prefers unmatched over bad matches; we then filter them out.
    big = radius * 1e6
    cost = np.where(dists <= radius, dists, big)
    rows, cols = linear_sum_assignment(cost)
    tp = int(sum(1 for r, c in zip(rows, cols) if dists[r, c] <= radius))
    return tp, len(pred) - tp, len(gt) - tp


def eval_pair(pred_path: Path, gt_path: Path, radius: float) -> dict:
    pred = load_points(pred_path)
    gt = load_points(gt_path)
    tp, fp, fn = match_points(pred, gt, radius)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    count_err = (len(pred) - len(gt)) / len(gt) if gt else float("nan")
    return {
        "pred_count": len(pred),
        "gt_count": len(gt),
        "radius_px": round(radius, 1),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "count_error_pct": round(100 * count_err, 2),
    }


def load_manifest() -> dict[str, dict]:
    with open(DATASET_DIR / "manifest.json") as f:
        manifest = json.load(f)
    return {m["stem"].lower(): m for m in manifest["images"]}


def radius_for(entry: dict | None, override: float | None) -> float:
    if override:
        return override
    if entry and entry.get("est_elk_size_px"):
        # NN-distance size estimates blow up on sparse images; clamp so the
        # radius stays at animal scale rather than herd-spacing scale.
        return max(8.0, min(40.0, 0.75 * entry["est_elk_size_px"]))
    return 20.0


def print_row(name: str, r: dict) -> None:
    print(
        f"{name:26s} pred={r['pred_count']:5d} gt={r['gt_count']:5d} "
        f"r={r['radius_px']:5.1f} P={r['precision']:.3f} R={r['recall']:.3f} "
        f"F1={r['f1']:.3f} cnt_err={r['count_error_pct']:+.1f}%"
    )


def aggregate(results: dict[str, dict]) -> dict:
    tp = sum(r["tp"] for r in results.values())
    fp = sum(r["fp"] for r in results.values())
    fn = sum(r["fn"] for r in results.values())
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    errs = [abs(r["pred_count"] - r["gt_count"]) for r in results.values()]
    pct_errs = [
        abs(r["count_error_pct"]) for r in results.values() if r["gt_count"] > 0
    ]
    return {
        "images": len(results),
        "micro_precision": round(precision, 4),
        "micro_recall": round(recall, 4),
        "micro_f1": round(f1, 4),
        "count_mae": round(float(np.mean(errs)), 2) if errs else None,
        "count_mape_pct": round(float(np.mean(pct_errs)), 2) if pct_errs else None,
    }


def run_baseline(radius_override: float | None) -> None:
    """Pipeline per-image exports (pre-review) vs reviewed dataset labels."""
    manifest = load_manifest()
    results: dict[str, dict] = {}
    for pred_path in sorted(EXPORTS_DIR.glob("annotations_*.json")):
        if "all_saved_work" in pred_path.name or "unified" in pred_path.name:
            continue
        with open(pred_path) as f:
            data = json.load(f)
        if "image" not in data:
            continue
        stem = Path(data["image"]["filename"]).stem.lower()
        entry = manifest.get(stem)
        if entry is None or entry["tier"] != "reviewed":
            continue  # no reviewed ground truth for this image
        gt_path = DATASET_DIR / entry["label_file"]
        radius = radius_for(entry, radius_override)
        r = eval_pair(pred_path, gt_path, radius)
        # Keep the harder (more informative) export when an image has several.
        if stem in results and results[stem]["f1"] <= r["f1"]:
            continue
        results[stem] = r

    print(f"Baseline: pipeline exports vs reviewed labels ({len(results)} images)\n")
    for stem in sorted(results):
        print_row(stem, results[stem])
    agg = aggregate(results)
    print(f"\nAggregate: {json.dumps(agg)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "baseline_pipeline_vs_reviewed.json"
    with open(out, "w") as f:
        json.dump({"per_image": results, "aggregate": agg}, f, indent=1)
    print(f"Saved -> {out.relative_to(BASE_DIR)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pred", type=Path, help="Prediction JSON file")
    parser.add_argument("--gt", help="Ground-truth stem in data/dataset, or a path")
    parser.add_argument("--radius", type=float, default=None, help="Match radius px")
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()

    if args.baseline:
        run_baseline(args.radius)
        return

    if not args.pred or not args.gt:
        parser.error("--pred and --gt required (or use --baseline)")

    gt_path = Path(args.gt)
    entry = None
    if not gt_path.exists():
        entry = load_manifest().get(args.gt.lower())
        if entry is None:
            parser.error(f"No dataset image with stem {args.gt!r}")
        gt_path = DATASET_DIR / entry["label_file"]

    r = eval_pair(args.pred, gt_path, radius_for(entry, args.radius))
    print_row(args.pred.stem, r)


if __name__ == "__main__":
    main()
