"""Experiment: Do pretrained embeddings separate confirmed elk from rejected FPs?

Extracts patches around annotations from the labeled corpus, embeds them with
pretrained models, and tests whether a simple linear classifier can distinguish
confirmed elk from rejected false positives.

Usage:
    python scripts/experiment_patch_embeddings.py [--skip-neural]

Requires: numpy, PIL, sklearn (+ torch/torchvision for neural embeddings)

Outputs:
    - Per-image and overall classification metrics
    - storage/output/embeddings/ with cached features and optional t-SNE plot
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.preprocessing import StandardScaler

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ANNOTATIONS_PATH = Path("data/annotations_all_saved_work.json")
IMAGES_DIR = Path("data/elk_images_from_fwp")
OUTPUT_DIR = Path("storage/output/embeddings")
PATCH_MULTIPLIER = 4  # patch side = max(64, PATCH_MULTIPLIER * estimated elk size)
MIN_PATCH_SIZE = 64
MODEL_INPUT_SIZE = 224
BATCH_SIZE = 64


def estimate_elk_size(annotations: list[dict]) -> float:
    """Estimate typical elk size from median nearest-neighbor distance among confirmed annotations."""
    confirmed = [(a["x"], a["y"]) for a in annotations if a.get("state") != "rejected"]
    if len(confirmed) < 3:
        return 20.0  # fallback

    from scipy.spatial import KDTree

    tree = KDTree(confirmed)
    dists, _ = tree.query(confirmed, k=2)  # k=2: self + nearest neighbor
    nn_dists = dists[:, 1]  # skip self-distance
    # Median nn distance is roughly the spacing; elk size is smaller
    # Use ~40% of median spacing as a rough elk body size
    return float(np.median(nn_dists) * 0.4)


def extract_patch(img: Image.Image, x: int, y: int, patch_size: int) -> Image.Image:
    """Extract a square patch centered on (x, y), clamped to image bounds."""
    w, h = img.size
    half = patch_size // 2
    x1 = max(0, x - half)
    y1 = max(0, y - half)
    x2 = min(w, x + half)
    y2 = min(h, y + half)

    patch = img.crop((x1, y1, x2, y2))
    # Resize to model input size
    patch = patch.resize((MODEL_INPUT_SIZE, MODEL_INPUT_SIZE), Image.Resampling.BILINEAR)
    return patch


def compute_baseline_features(patches: list[Image.Image]) -> np.ndarray:
    """Compute simple pixel-statistic features for baseline comparison.

    Features (19-dim):
    - mean brightness, std brightness, edge energy (3)
    - 16-bin normalized histogram (16)
    """
    features = []
    for patch in patches:
        arr = np.array(patch.convert("L"), dtype=np.float32)  # grayscale
        mean_brightness = arr.mean()
        std_brightness = arr.std()
        # Edge energy via simple gradient
        gy, gx = np.gradient(arr)
        edge_energy = np.sqrt(gx**2 + gy**2).mean()
        # Histogram (16 bins, normalized)
        hist, _ = np.histogram(arr.ravel(), bins=16, range=(0, 256))
        hist = hist.astype(np.float32) / (hist.sum() + 1e-8)
        features.append(np.concatenate([[mean_brightness, std_brightness, edge_energy], hist]))

    return np.array(features)


def compute_extended_baseline_features(patches: list[Image.Image]) -> np.ndarray:
    """Extended pixel-statistic features including color and texture.

    Features (67-dim):
    - grayscale: mean, std, edge energy (3)
    - grayscale 16-bin histogram (16)
    - per-channel (R,G,B): mean, std (6)
    - per-channel 8-bin histograms (24)
    - local binary pattern-like: variance of 3x3 neighborhood means (1)
    - Sobel edge orientation histogram (8 bins) (8)
    - patch center vs. surround brightness ratio (1)
    - contrast (90th - 10th percentile brightness) (1)
    - skewness, kurtosis of brightness (2)
    - fraction of very dark pixels (< 80) (1)
    - fraction of very bright pixels (> 200) (1)
    - edge density (fraction of pixels with gradient > mean gradient) (1)
    - mean color saturation (1)
    - dominant color channel ratio (1)
    - texture energy (sum of squared Laplacian) (1)
    """
    features = []
    for patch in patches:
        rgb = np.array(patch.convert("RGB"), dtype=np.float32)
        gray = np.array(patch.convert("L"), dtype=np.float32)

        # Basic grayscale
        mean_brightness = gray.mean()
        std_brightness = gray.std()
        gy, gx = np.gradient(gray)
        grad_mag = np.sqrt(gx**2 + gy**2)
        edge_energy = grad_mag.mean()

        # Grayscale histogram
        hist_gray, _ = np.histogram(gray.ravel(), bins=16, range=(0, 256))
        hist_gray = hist_gray.astype(np.float32) / (hist_gray.sum() + 1e-8)

        # Per-channel stats and histograms
        channel_stats = []
        channel_hists = []
        for c in range(3):
            ch = rgb[:, :, c]
            channel_stats.extend([ch.mean(), ch.std()])
            h, _ = np.histogram(ch.ravel(), bins=8, range=(0, 256))
            channel_hists.extend((h.astype(np.float32) / (h.sum() + 1e-8)).tolist())

        # Local variance (texture roughness)
        from scipy.ndimage import uniform_filter
        local_mean = uniform_filter(gray, size=3)
        local_var = uniform_filter((gray - local_mean) ** 2, size=3)
        texture_roughness = local_var.mean()

        # Edge orientation histogram
        angles = np.arctan2(gy, gx + 1e-8)
        angle_hist, _ = np.histogram(angles.ravel(), bins=8, range=(-np.pi, np.pi),
                                      weights=grad_mag.ravel())
        angle_hist = angle_hist.astype(np.float32) / (angle_hist.sum() + 1e-8)

        # Center vs surround
        h, w = gray.shape
        center = gray[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4].mean()
        surround_mean = mean_brightness  # whole patch mean as proxy
        center_surround = center / (surround_mean + 1e-8)

        # Contrast
        contrast = float(np.percentile(gray, 90) - np.percentile(gray, 10))

        # Higher moments
        centered = gray - mean_brightness
        skewness = (centered**3).mean() / (std_brightness**3 + 1e-8)
        kurtosis = (centered**4).mean() / (std_brightness**4 + 1e-8) - 3.0

        # Dark/bright fractions
        frac_dark = (gray < 80).mean()
        frac_bright = (gray > 200).mean()

        # Edge density
        edge_density = (grad_mag > edge_energy).mean()

        # Color saturation (mean of max-min across channels per pixel)
        sat = rgb.max(axis=2) - rgb.min(axis=2)
        mean_saturation = sat.mean() / 255.0

        # Dominant channel ratio
        channel_means = rgb.mean(axis=(0, 1))
        dominant_ratio = channel_means.max() / (channel_means.sum() + 1e-8)

        # Texture energy (Laplacian)
        from scipy.ndimage import laplace
        lap = laplace(gray)
        texture_energy = (lap**2).mean()

        feat = np.concatenate([
            [mean_brightness, std_brightness, edge_energy],
            hist_gray,
            channel_stats,
            channel_hists,
            [texture_roughness],
            angle_hist,
            [center_surround, contrast, skewness, kurtosis],
            [frac_dark, frac_bright, edge_density],
            [mean_saturation, dominant_ratio, texture_energy],
        ])
        features.append(feat)

    return np.array(features)


def load_neural_model():
    """Load a pretrained model for feature extraction. Tries DINOv2, falls back to MobileNetV3."""
    import torch
    import torchvision.models as models

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

    # Try DINOv2 first
    try:
        print(f"Trying DINOv2-small on {device}...")
        model = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14", pretrained=True)
        model = model.to(device)
        model.eval()
        return model, device, "dinov2", 384
    except Exception as e:
        print(f"  DINOv2 failed ({e}), falling back to MobileNetV3-small...")

    # Fall back to MobileNetV3-small (smaller download, ~10MB)
    try:
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
        full_model = models.mobilenet_v3_small(weights=weights)
        # Use features only (before classifier head)
        # MobileNetV3-small features output: (B, 576, 7, 7) -> pool -> (B, 576)
        import torch.nn as nn
        model = nn.Sequential(
            full_model.features,
            full_model.avgpool,
            nn.Flatten(),
        )
        model = model.to(device)
        model.eval()
        return model, device, "mobilenetv3", 576
    except Exception as e:
        print(f"  MobileNetV3 also failed ({e})")
        return None, device, None, 0


def patches_to_tensor(patches: list[Image.Image]):
    """Convert PIL images to a normalized tensor batch."""
    import torch

    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)

    tensors = []
    for patch in patches:
        arr = np.array(patch.convert("RGB"), dtype=np.float32) / 255.0
        t = torch.from_numpy(arr).permute(2, 0, 1)  # HWC -> CHW
        t = (t - mean) / std
        tensors.append(t)

    return torch.stack(tensors)


def embed_patches_neural(model, device: str, patches: list[Image.Image]) -> np.ndarray:
    """Get neural network embeddings for a list of patches."""
    import torch

    all_embeddings = []
    with torch.no_grad():
        for i in range(0, len(patches), BATCH_SIZE):
            batch = patches[i : i + BATCH_SIZE]
            tensor = patches_to_tensor(batch).to(device)
            embeddings = model(tensor)
            all_embeddings.append(embeddings.cpu().numpy())
            if (i // BATCH_SIZE) % 10 == 0 and i > 0:
                print(f"    Embedded {i}/{len(patches)} patches...")

    return np.concatenate(all_embeddings, axis=0)


def collect_patches(
    annotations_path: Path, images_dir: Path
) -> tuple[list[Image.Image], np.ndarray, np.ndarray]:
    """Load annotations and extract patches. Returns (patches, labels, image_ids)."""
    with open(annotations_path) as f:
        data = json.load(f)

    images = data.get("images", [])
    print(f"Loaded {len(images)} images from {annotations_path}")

    all_patches: list[Image.Image] = []
    all_labels: list[int] = []
    all_image_ids: list[str] = []
    skipped_images = []

    for img_entry in images:
        img_info = img_entry["image"]
        filename = img_info["filename"]
        annotations = img_entry["annotations"]

        img_path = images_dir / filename
        if not img_path.exists():
            matches = [m for m in images_dir.glob(f"*{Path(filename).suffix}")
                       if m.name.lower() == filename.lower()]
            if matches:
                img_path = matches[0]
            else:
                skipped_images.append(filename)
                continue

        confirmed = [a for a in annotations
                     if a.get("state") in ("confirmed", "manually-added", "auto-detected")]
        rejected = [a for a in annotations if a.get("state") == "rejected"]

        if len(rejected) < 2:
            continue

        elk_size = estimate_elk_size(annotations)
        patch_size = max(MIN_PATCH_SIZE, int(PATCH_MULTIPLIER * elk_size))

        img = Image.open(img_path)

        for ann in confirmed:
            patch = extract_patch(img, int(ann["x"]), int(ann["y"]), patch_size)
            all_patches.append(patch)
            all_labels.append(1)
            all_image_ids.append(filename)

        for ann in rejected:
            patch = extract_patch(img, int(ann["x"]), int(ann["y"]), patch_size)
            all_patches.append(patch)
            all_labels.append(0)
            all_image_ids.append(filename)

        print(f"  {filename}: {len(confirmed)} confirmed, {len(rejected)} rejected, "
              f"elk_size≈{elk_size:.0f}px, patch={patch_size}px")

    if skipped_images:
        print(f"\nSkipped {len(skipped_images)} images (not found): {skipped_images[:5]}...")

    labels = np.array(all_labels)
    image_ids = np.array(all_image_ids)
    print(f"\nTotal patches: {len(all_patches)} ({labels.sum()} positive, "
          f"{(1 - labels).sum()} negative)")

    return all_patches, labels, image_ids


def evaluate_features(
    features: np.ndarray, labels: np.ndarray, image_ids: np.ndarray,
    name: str, n_features: int | None = None,
):
    """Run cross-validated evaluation and print results."""
    if n_features:
        print(f"\n=== {name} ({n_features}-dim) ===")
    else:
        print(f"\n=== {name} ({features.shape[1]}-dim) ===")

    scaler = StandardScaler()
    scaled = scaler.fit_transform(features)

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    clf = LogisticRegression(max_iter=1000, random_state=42, C=1.0)
    preds = cross_val_predict(clf, scaled, labels, cv=cv)
    probs = cross_val_predict(clf, scaled, labels, cv=cv, method="predict_proba")

    print(f"Overall accuracy: {accuracy_score(labels, preds):.3f}")
    print(classification_report(labels, preds, target_names=["rejected", "confirmed"]))

    # Per-image breakdown using global classifier predictions
    print(f"Per-Image Breakdown ({name}, global classifier):")
    unique_images = sorted(set(image_ids))
    for img_id in unique_images:
        mask = image_ids == img_id
        if mask.sum() < 5:
            continue
        img_labels = labels[mask]
        img_preds = preds[mask]
        n_pos = img_labels.sum()
        n_neg = (1 - img_labels).sum()
        acc = accuracy_score(img_labels, img_preds)
        print(f"  {img_id}: acc={acc:.3f}  ({n_pos} pos, {n_neg} neg)")

    # Per-image independent classifiers
    print(f"\nPer-Image Independent Classifiers ({name}):")
    print("(Trains a separate classifier per image using only that image's data)")
    per_image_results = []
    for img_id in unique_images:
        mask = image_ids == img_id
        img_features = scaled[mask]
        img_labels = labels[mask]
        n_pos = int(img_labels.sum())
        n_neg = int((1 - img_labels).sum())
        if n_neg < 3 or n_pos < 3:
            continue

        n_splits = min(5, min(n_pos, n_neg))
        if n_splits < 2:
            continue

        try:
            img_cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
            img_clf = LogisticRegression(max_iter=1000, random_state=42, C=1.0)
            img_preds = cross_val_predict(img_clf, img_features, img_labels, cv=img_cv)
            acc = accuracy_score(img_labels, img_preds)
            per_image_results.append((img_id, acc, n_pos, n_neg))
            print(f"  {img_id}: acc={acc:.3f}  ({n_pos} pos, {n_neg} neg)")
        except Exception as e:
            print(f"  {img_id}: FAILED ({e})")

    if per_image_results:
        accs = [r[1] for r in per_image_results]
        weights = [r[2] + r[3] for r in per_image_results]
        weighted_mean = sum(a * w for a, w in zip(accs, weights)) / sum(weights)
        print(f"\n  Weighted mean per-image accuracy: {weighted_mean:.3f}")
        print(f"  Unweighted mean: {np.mean(accs):.3f}")
        print(f"  Min: {min(accs):.3f}, Max: {max(accs):.3f}")

    return preds, probs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-neural", action="store_true",
                        help="Skip neural network embeddings (no torch needed)")
    args = parser.parse_args()

    if not ANNOTATIONS_PATH.exists():
        print(f"ERROR: {ANNOTATIONS_PATH} not found")
        sys.exit(1)

    all_patches, labels, image_ids = collect_patches(ANNOTATIONS_PATH, IMAGES_DIR)

    if len(all_patches) < 20:
        print("ERROR: Too few patches to run experiment")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # --- Baseline: simple pixel statistics ---
    print("\nComputing baseline pixel statistics...")
    baseline_features = compute_baseline_features(all_patches)
    evaluate_features(baseline_features, labels, image_ids, "Baseline (simple pixel stats)")

    # --- Extended baseline: richer pixel statistics ---
    print("\nComputing extended pixel statistics...")
    extended_features = compute_extended_baseline_features(all_patches)
    evaluate_features(extended_features, labels, image_ids, "Extended Baseline (rich pixel stats)")

    # --- Neural embeddings ---
    neural_embeddings = None
    model_name = None

    if not args.skip_neural:
        try:
            model, device, model_name, embed_dim = load_neural_model()
            if model is not None:
                print(f"\nComputing {model_name} embeddings...")
                neural_embeddings = embed_patches_neural(model, device, all_patches)
                print(f"Embedding shape: {neural_embeddings.shape}")
                evaluate_features(neural_embeddings, labels, image_ids,
                                  f"{model_name} embeddings", embed_dim)

                # Also try combined: neural + extended baseline
                combined = np.hstack([neural_embeddings, extended_features])
                evaluate_features(combined, labels, image_ids,
                                  f"{model_name} + extended baseline (combined)")
        except ImportError:
            print("\ntorch/torchvision not available, skipping neural embeddings")
            print("Run with --skip-neural to suppress this message")
    else:
        print("\nSkipping neural embeddings (--skip-neural)")

    # --- Save everything ---
    save_data = {
        "baseline_features": baseline_features,
        "extended_features": extended_features,
        "labels": labels,
        "image_ids": image_ids,
    }
    if neural_embeddings is not None:
        save_data["neural_embeddings"] = neural_embeddings
        save_data["neural_model_name"] = np.array([model_name])

    np.savez(OUTPUT_DIR / "patch_features.npz", **save_data)
    print(f"\nSaved features to {OUTPUT_DIR / 'patch_features.npz'}")

    # --- Optional: t-SNE visualization ---
    best_features = neural_embeddings if neural_embeddings is not None else extended_features
    best_name = model_name or "extended_baseline"
    try:
        import matplotlib
        from sklearn.manifold import TSNE
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        print("\nGenerating t-SNE visualization...")
        scaler = StandardScaler()
        scaled = scaler.fit_transform(best_features)

        max_points = 3000
        if len(scaled) > max_points:
            idx = np.random.RandomState(42).choice(len(scaled), max_points, replace=False)
            tsne_data = scaled[idx]
            tsne_labels = labels[idx]
        else:
            tsne_data = scaled
            tsne_labels = labels

        tsne = TSNE(n_components=2, random_state=42, perplexity=30)
        coords = tsne.fit_transform(tsne_data)

        plt.figure(figsize=(12, 8))
        for label_val, name, color in [(0, "rejected", "red"), (1, "confirmed", "green")]:
            mask = tsne_labels == label_val
            plt.scatter(coords[mask, 0], coords[mask, 1], c=color, alpha=0.4, s=10, label=name)
        plt.legend()
        plt.title(f"Patch Embeddings ({best_name}) — Confirmed vs Rejected")
        plt.tight_layout()
        plt.savefig(OUTPUT_DIR / f"tsne_{best_name}.png", dpi=150)
        print(f"Saved t-SNE plot to {OUTPUT_DIR / f'tsne_{best_name}.png'}")
    except ImportError:
        print("matplotlib not available, skipping t-SNE visualization")


if __name__ == "__main__":
    main()
