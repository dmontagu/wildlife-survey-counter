"""Consolidate annotation exports into a canonical dataset.

Sources, in trust order (highest first):
1. data/annotations_all_saved_work.json          — master reviewed export (2026-03-09)
2. data/exported_annotations/many_annotations_unified.json — earlier reviewed export (2026-03-08)
3. data/exported_annotations/annotations_<name>.json       — per-image pipeline output (mostly unreviewed)

data/exported_annotations/annotations_all_saved_work (5).json (2026-06-05) is
compared against the master and reported as a conflict when it differs; it is
never auto-merged because its per-image state contains *less* review work than
the master despite the later export date (likely a stale browser profile).

Outputs:
    data/dataset/labels/<stem>.json   — normalized annotations per image
    data/dataset/manifest.json        — per-image metadata + review tier
    data/dataset/conflicts.json       — anything requiring human judgment

Usage:
    python scripts/build_dataset.py
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from statistics import median

BASE_DIR = Path(__file__).parent.parent
IMAGES_DIR = BASE_DIR / "data" / "elk_images_from_fwp"
EXPORTS_DIR = BASE_DIR / "data" / "exported_annotations"
MASTER_PATH = BASE_DIR / "data" / "annotations_all_saved_work.json"
UNIFIED_PATH = EXPORTS_DIR / "many_annotations_unified.json"
JUNE_PATH = EXPORTS_DIR / "annotations_all_saved_work (5).json"
OUT_DIR = BASE_DIR / "data" / "dataset"

KEPT_STATES = {"auto-detected", "confirmed", "manually-added"}

# Images whose saved work is a partial import, not a finished review
# (a few auto-detected points, zero review signal, but VLM inspection
# shows large unlabeled herds). Excluded from training and eval until
# properly reviewed.
SUSPECT_STEMS = {"img_3930", "img_3938", "img_3955"}


def norm_key(filename: str) -> str:
    """Case-insensitive stem used to join exports to disk files."""
    return Path(filename).stem.lower()


def disk_images() -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in sorted(IMAGES_DIR.iterdir()):
        if p.suffix.lower() in (".jpg", ".jpeg", ".png"):
            out[norm_key(p.name)] = p
    return out


def normalize_annotation(a: dict) -> dict:
    return {
        "id": a.get("id"),
        "x": a["x"],
        "y": a["y"],
        "bbox": a.get("bbox"),
        "detection_confidence": a.get("detection_confidence"),
        "source": a.get("source"),
        "label": a.get("label") or "elk",
        "state": a.get("state") or "auto-detected",
        "reviewStatus": a.get("reviewStatus") or "unconfirmed",
    }


def estimate_elk_size(annotations: list[dict]) -> float | None:
    """Median nearest-neighbor distance among kept points, scaled to body size."""
    pts = [(a["x"], a["y"]) for a in annotations if a["state"] in KEPT_STATES]
    if len(pts) < 5:
        return None
    dists = []
    for i, (x, y) in enumerate(pts):
        best = None
        for j, (x2, y2) in enumerate(pts):
            if i == j:
                continue
            d = ((x - x2) ** 2 + (y - y2) ** 2) ** 0.5
            if best is None or d < best:
                best = d
        dists.append(best)
    return round(median(dists) * 0.4, 1)


def classify_rejected(annotations: list[dict], elk_size: float | None) -> None:
    """Split `rejected` into semantic kinds, in place.

    VLM patch experiments (2026-07-19) showed `rejected` conflates three things:
      - duplicate:      a second detection of an already-kept animal
      - false-positive: genuinely not an animal
      - image-rejected: wholesale rejection (e.g. duplicate frame coverage)
    Heuristic: rejected within 2.5 elk-sizes of a kept point = duplicate.
    """
    kept = [(a["x"], a["y"]) for a in annotations if a["state"] in KEPT_STATES]
    threshold = 2.5 * (elk_size or 20.0)
    for a in annotations:
        if a["state"] != "rejected":
            continue
        if not kept:
            a["rejected_kind"] = "image-rejected"
            continue
        d = min(((a["x"] - x) ** 2 + (a["y"] - y) ** 2) ** 0.5 for x, y in kept)
        a["rejected_kind"] = "duplicate" if d <= threshold else "false-positive"


def summarize(annotations: list[dict]) -> dict:
    states = Counter(a["state"] for a in annotations)
    kinds = Counter(a.get("rejected_kind") for a in annotations if a["state"] == "rejected")
    return {
        "total": len(annotations),
        "kept": sum(1 for a in annotations if a["state"] in KEPT_STATES),
        "rejected": states.get("rejected", 0),
        "rejected_duplicate": kinds.get("duplicate", 0),
        "rejected_false_positive": kinds.get("false-positive", 0),
        "rejected_image": kinds.get("image-rejected", 0),
        "manually_added": states.get("manually-added", 0),
        "auto_detected": states.get("auto-detected", 0),
        "confirmed_reviews": sum(1 for a in annotations if a["reviewStatus"] == "confirmed"),
    }


def load_unified(path: Path) -> dict[str, dict]:
    """Load a unified export -> {norm_key: entry}. Later duplicate entries win
    only if non-empty (the exports contain some empty duplicate rows)."""
    with open(path) as f:
        data = json.load(f)
    out: dict[str, dict] = {}
    for entry in data.get("images", []):
        key = norm_key(entry["image"]["filename"])
        if key in out and not entry.get("annotations"):
            continue
        out[key] = entry
    return out


def load_per_image_exports() -> dict[str, tuple[str, dict]]:
    """Load per-image exports -> {norm_key: (source_filename, entry)}."""
    out: dict[str, tuple[str, dict]] = {}
    for p in sorted(EXPORTS_DIR.glob("annotations_*.json")):
        if "all_saved_work" in p.name or p == UNIFIED_PATH:
            continue
        with open(p) as f:
            data = json.load(f)
        if "annotations" not in data or "image" not in data:
            continue
        key = norm_key(data["image"]["filename"])
        # Multiple exports per image (e.g. DSC01274 + DSC01274_blob): keep the
        # one with more annotations; they are all pipeline artifacts anyway.
        if key in out and len(out[key][1]["annotations"]) >= len(data["annotations"]):
            continue
        out[key] = (p.name, data)
    return out


def main() -> None:
    images = disk_images()
    master = load_unified(MASTER_PATH)
    unified = load_unified(UNIFIED_PATH)
    june = load_unified(JUNE_PATH)
    per_image = load_per_image_exports()

    labels_dir = OUT_DIR / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)

    manifest: list[dict] = []
    conflicts: list[dict] = []

    all_keys = sorted(set(master) | set(unified) | set(per_image))
    for key in all_keys:
        if key in master:
            entry = master[key]
            tier = "reviewed"
            source = MASTER_PATH.name
        elif key in unified:
            entry = unified[key]
            tier = "reviewed"
            source = UNIFIED_PATH.name
        else:
            source, entry = per_image[key]
            tier = "pipeline"

        annotations = [normalize_annotation(a) for a in entry.get("annotations", [])]
        elk_size_est = estimate_elk_size(annotations)
        classify_rejected(annotations, elk_size_est)
        stats = summarize(annotations)

        if norm_key(entry["image"]["filename"]) in SUSPECT_STEMS:
            tier = "unreviewed-suspect"
            conflicts.append({
                "image": entry["image"]["filename"],
                "kind": "unfinished-review",
                "note": "Only a few auto-detected points, no review signal; "
                "VLM inspection shows a large unlabeled herd. Needs review.",
            })

        # Per-image exports with real review signal get an intermediate tier.
        if tier == "pipeline" and (stats["rejected"] > 0 or stats["manually_added"] > 0):
            tier = "partially-reviewed"

        # Conflict: wholesale-rejected image (rejections do not mean not-elk;
        # VLM inspection found clear animals in DSC01274's rejected patches).
        if stats["rejected_image"] > 0:
            conflicts.append(
                {
                    "image": entry["image"]["filename"],
                    "kind": "image-wholesale-rejected",
                    "rejected": stats["rejected_image"],
                    "note": "Every annotation rejected but animals are visible in "
                    "patches. Was this frame intentionally zeroed (duplicate "
                    "coverage of the same herd)? Excluded from hard negatives.",
                }
            )

        # Conflict: June export disagrees with the chosen labels.
        if key in june and key in master:
            june_stats = summarize([normalize_annotation(a) for a in june[key]["annotations"]])
            if june_stats != stats:
                conflicts.append(
                    {
                        "image": entry["image"]["filename"],
                        "kind": "june-export-differs",
                        "chosen": {"source": source, **stats},
                        "june_2026_06_05": june_stats,
                        "note": "June export has less review work despite later date; "
                        "master kept. Re-export from the browser that has the "
                        "latest state if this image was re-reviewed after March.",
                    }
                )

        # Conflict: image also present in earlier unified export with different counts.
        if key in master and key in unified:
            u_stats = summarize([normalize_annotation(a) for a in unified[key]["annotations"]])
            if u_stats["kept"] != stats["kept"]:
                conflicts.append(
                    {
                        "image": entry["image"]["filename"],
                        "kind": "mar08-unified-differs",
                        "chosen": {"source": source, **stats},
                        "mar08_unified": u_stats,
                        "note": "Master (Mar 9) kept; Mar 8 export differs.",
                    }
                )

        disk_path = images.get(key)
        if disk_path is None:
            conflicts.append(
                {
                    "image": entry["image"]["filename"],
                    "kind": "image-file-missing",
                    "note": f"No file in {IMAGES_DIR.name}/ matches (case-insensitive stem).",
                }
            )

        stem = disk_path.stem if disk_path else Path(entry["image"]["filename"]).stem
        label_path = labels_dir / f"{stem}.json"
        with open(label_path, "w") as f:
            json.dump(
                {
                    "image": {
                        "filename": disk_path.name if disk_path else entry["image"]["filename"],
                        "width": entry["image"].get("width"),
                        "height": entry["image"].get("height"),
                    },
                    "annotations": annotations,
                },
                f,
                indent=1,
            )

        manifest.append(
            {
                "stem": stem,
                "image_file": disk_path.name if disk_path else None,
                "label_file": f"labels/{label_path.name}",
                "width": entry["image"].get("width"),
                "height": entry["image"].get("height"),
                "tier": tier,
                "source": source,
                "est_elk_size_px": elk_size_est,
                "background": None,  # filled in later (VLM or manual pass)
                **stats,
            }
        )

    labeled_keys = set(all_keys)
    unlabeled = [p.name for k, p in sorted(images.items()) if k not in labeled_keys]

    with open(OUT_DIR / "manifest.json", "w") as f:
        json.dump(
            {
                "generated_by": "scripts/build_dataset.py",
                "images_dir": str(IMAGES_DIR.relative_to(BASE_DIR)),
                "images": manifest,
                "unlabeled_images": unlabeled,
            },
            f,
            indent=1,
        )
    with open(OUT_DIR / "conflicts.json", "w") as f:
        json.dump(conflicts, f, indent=1)

    tiers = Counter(m["tier"] for m in manifest)
    print(f"Wrote {len(manifest)} label files to {labels_dir.relative_to(BASE_DIR)}/")
    print(f"Tiers: {dict(tiers)}")
    print(f"Total kept points: {sum(m['kept'] for m in manifest)}")
    print(f"Total rejected (hard negatives): {sum(m['rejected'] for m in manifest)}")
    print(f"Unlabeled images on disk: {len(unlabeled)}: {unlabeled}")
    print(f"Conflicts: {len(conflicts)} -> {OUT_DIR.relative_to(BASE_DIR) / 'conflicts.json'}")
    for c in conflicts:
        print(f"  - {c['kind']}: {c['image']}")


if __name__ == "__main__":
    main()
