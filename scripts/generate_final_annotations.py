"""Generate final annotation files for target images.

Loads SAHI detections, applies visual filtering decisions, generates annotation JSONs
and final verification images.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2


def load_sahi_detections(meta_path):
    with open(meta_path) as f:
        meta = json.load(f)
    return meta["detections"], meta["image_width"], meta["image_height"]


def filter_detections(detections, remove_indices):
    """Remove detections by 0-based index."""
    return [d for i, d in enumerate(detections) if i not in remove_indices]


def filter_by_region(detections, exclude_regions):
    """Remove detections falling within excluded regions.

    exclude_regions: list of (x_min, y_min, x_max, y_max) tuples
    """
    kept = []
    removed = []
    for d in detections:
        in_excluded = False
        for x_min, y_min, x_max, y_max in exclude_regions:
            if x_min <= d["x"] <= x_max and y_min <= d["y"] <= y_max:
                in_excluded = True
                break
        if in_excluded:
            removed.append(d)
        else:
            kept.append(d)
    return kept, removed


def generate_annotation_json(filename, width, height, detections, output_path):
    """Generate annotation file in app import format."""
    annotations = []
    for i, d in enumerate(detections, 1):
        annotations.append({
            "id": i,
            "x": d["x"],
            "y": d["y"],
            "bbox": None,
            "detection_confidence": None,
            "classification_confidence": None,
            "source": "sahi+manual",
            "label": "elk",
            "category": None,
            "state": "auto-detected",
        })

    data = {
        "image": {
            "filename": filename,
            "sourceFilename": filename,
            "width": width,
            "height": height,
        },
        "summary": {
            "counted": len(annotations),
            "ignored": 0,
            "bulls": 0,
            "spikes": 0,
        },
        "annotations": annotations,
    }

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Saved: {output_path} ({len(annotations)} annotations)")
    return data


def generate_final_verification(image_path, detections, output_path):
    """Generate clean verification image with final annotations."""
    img = cv2.imread(str(image_path))
    for i, d in enumerate(detections):
        x, y = d["x"], d["y"]
        cv2.circle(img, (x, y), 8, (0, 255, 0), 2)
        cv2.circle(img, (x, y), 2, (0, 255, 0), -1)

    label = f"Final: {len(detections)} elk"
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (255, 255, 255), 4)
    cv2.putText(img, label, (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 200, 0), 2)
    cv2.imwrite(str(output_path), img)
    print(f"  Verification: {output_path}")


def main():
    base_dir = Path(__file__).parent.parent
    img_dir = base_dir / "data" / "elk_images_from_fwp"
    hybrid_dir = base_dir / "storage" / "output" / "hybrid"
    anno_dir = base_dir / "data" / "exported_annotations"
    verify_dir = base_dir / "storage" / "output" / "final_verification"
    verify_dir.mkdir(parents=True, exist_ok=True)

    # =========================================================================
    # Visual filtering decisions based on patch inspection
    # =========================================================================
    filter_configs = {
        "IMG_3706": {
            "filename": "IMG_3706.jpg",
            "exclude_regions": [
                # Upper-left isolated detection near terrain tracks (around detection #47)
                # Approximate region: x=650-750, y=640-740
                (600, 600, 800, 800),
            ],
            "notes": "1 FP near terrain tracks in upper area. All herd detections look correct.",
        },
        "IMG_3708": {
            "filename": "IMG_3708.jpg",
            "exclude_regions": [],
            "notes": "All 99 detections appear to be on actual elk. Dense running herd, well-detected.",
        },
        "IMG_3712": {
            "filename": "IMG_3712.jpg",
            "exclude_regions": [
                # Upper tree-heavy area R0C1: detections on trees, not elk
                # Region above the main elk line, roughly y < 900, x in 1200-2600
                (1200, 0, 2600, 900),
                # Upper-right tree area R0C2: detections #136,94,130,101,55,8,138
                # Region: x > 2542, y < 1346
                (2542, 0, 3888, 1200),
                # A few scattered detections far from the main elk line
                # Upper-left corner detection
                (0, 0, 600, 800),
            ],
            "notes": "~10 FPs in upper tree-covered areas. Main elk line detections are excellent.",
        },
        "IMG_3733": {
            "filename": "IMG_3733.jpg",
            "exclude_regions": [
                # Upper-left isolated detection near tree (detection #44)
                (800, 400, 1100, 700),
            ],
            "notes": "1-2 FPs near trees. Elk-sagebrush discrimination was surprisingly good.",
        },
    }

    for img_key, config in filter_configs.items():
        img_name = f"{img_key}.JPG"
        stem = img_key.lower()
        meta_path = hybrid_dir / stem / f"{stem}_meta.json"

        print(f"\n{'='*60}")
        print(f"{img_name}")
        print(f"{'='*60}")

        detections, w, h = load_sahi_detections(meta_path)
        print(f"  SAHI detections: {len(detections)}")

        # Apply region-based filtering
        if config["exclude_regions"]:
            filtered, removed = filter_by_region(detections, config["exclude_regions"])
            print(f"  Removed {len(removed)} FPs in excluded regions")
            for r in removed:
                print(f"    - ({r['x']}, {r['y']}) conf={r['conf']:.3f} class={r['class']}")
            detections = filtered
        print(f"  Final count: {len(detections)}")
        print(f"  Notes: {config['notes']}")

        # Generate annotation JSON
        anno_path = anno_dir / f"annotations_{img_key}.json"
        generate_annotation_json(config["filename"], w, h, detections, anno_path)

        # Generate verification image
        img_path = img_dir / img_name
        generate_final_verification(img_path, detections, verify_dir / f"{stem}_final.jpg")


if __name__ == "__main__":
    main()
