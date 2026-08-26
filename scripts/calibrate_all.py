"""Measure per-image elk pixel size from detector bboxes (640-tile SAHI pass).

The NN-distance estimator in the manifest collapses in dense herds (said 11px
for DSC00608, truth ~42px). Detector bbox medians are accurate wherever the
detector fires at all. Results cached to data/dataset/calibration.json;
images where the detector finds <5 animals keep the NN fallback.

Usage: uv run python scripts/calibrate_all.py
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

from scripts.auto_annotate import IMAGES_DIR, sahi_pass  # noqa: E402

DATASET_DIR = BASE_DIR / "data" / "dataset"
OUT_PATH = DATASET_DIR / "calibration.json"


def main() -> None:
    with open(DATASET_DIR / "manifest.json") as f:
        manifest = json.load(f)
    results: dict[str, dict] = {}
    if OUT_PATH.exists():
        results = json.loads(OUT_PATH.read_text())

    for m in manifest["images"]:
        stem = m["stem"]
        if stem in results or not m["image_file"]:
            continue
        try:
            dets = sahi_pass(IMAGES_DIR / m["image_file"], conf=0.03, tile=640, overlap=0.2)
        except Exception as e:
            print(f"{stem}: FAILED {e}", flush=True)
            continue
        widths = sorted(d["w"] for d in dets)
        entry = {
            "n_detections": len(dets),
            "bbox_median_w": round(statistics.median(widths), 1) if widths else None,
            "nn_estimate": m["est_elk_size_px"],
        }
        entry["elk_px"] = (
            entry["bbox_median_w"] if len(dets) >= 5 else m["est_elk_size_px"]
        )
        results[stem] = entry
        OUT_PATH.write_text(json.dumps(results, indent=1))
        print(f"{stem}: dets={len(dets)} bbox_med={entry['bbox_median_w']} "
              f"nn={entry['nn_estimate']} -> elk_px={entry['elk_px']}", flush=True)

    print(f"done: {len(results)} images -> {OUT_PATH}")


if __name__ == "__main__":
    main()
