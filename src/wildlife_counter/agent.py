from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

from wildlife_counter.config import settings
from wildlife_counter.sandbox import RunResult, Sandbox, SubprocessSandbox

DETECTION_SYSTEM_PROMPT = """\
You are a wildlife detection specialist. Given an aerial survey photograph,
your job is to locate and count individual animals, producing point annotations.

## Available Environment

Your sandbox has Python with these packages:
- opencv-python (cv2), numpy, pillow (PIL), scipy, scikit-image
- ultralytics (YOLO — pre-downloaded yolov8x.pt)
- transformers (OWLv2 — google/owlv2-base-patch16-ensemble)

The input image is at `/work/input.jpg` (full resolution).
You can write output files to `/work/` (e.g., annotated images, JSON).

**Important**: These ML packages may or may not be installed in the current environment.
If an import fails, fall back to packages that are available (opencv + numpy are always available).

## Decision Process

1. **LOOK** at the image. Describe what you see: species, approximate count,
   terrain, lighting, animal size relative to image, density.

2. **DECIDE** on a detection approach based on what you see:
   - Large/medium animals (>30px): Use OWLv2 with text prompts, optionally fused with YOLO
   - Tiny animals (<20px) on high-contrast background: Use blob detection (threshold + morphology + contour finding)
   - Mixed sizes or uncertain: Start with one approach, evaluate, then supplement

3. **RUN** detection using the `run_python` tool. Start with conservative parameters.

4. **EVALUATE** results: Are the annotation count and placement plausible given
   your initial visual assessment? Use `read_file` to inspect annotated images.

5. **ITERATE** if needed: Adjust thresholds, NMS parameters, or try a different
   approach. You may run multiple iterations to converge on accurate results.

6. **SUBMIT** final annotations using the `submit_annotations` tool.

## When to Decline

If the image is not an aerial wildlife survey photo (e.g., a close-up of a
single animal, a landscape without visible wildlife, a non-wildlife photo),
say so clearly and submit zero annotations with an explanation in method_summary.

## Key Guidelines

- **Point annotations** (x, y center of each animal), not bounding boxes
- Prefer undercounting to overcounting — false negatives > false positives
- Your initial visual estimate is a sanity check: if detection is >30% off, iterate
- Different images need different parameters — never use one-size-fits-all
- Generate annotated images to visually verify your results before submitting
- When using OWLv2, threshold 0.03-0.06 is typical; for YOLO, conf=0.005-0.01
- Box-aware NMS with scale=0.35-0.45 works well for deduplication

## Code Patterns

### OWLv2 Detection
```python
from transformers import Owlv2Processor, Owlv2ForObjectDetection
from PIL import Image
import torch

processor = Owlv2Processor.from_pretrained("google/owlv2-base-patch16-ensemble")
model = Owlv2ForObjectDetection.from_pretrained("google/owlv2-base-patch16-ensemble")
img = Image.open("/work/input.jpg")
inputs = processor(text=[["an elk", "a deer"]], images=img, return_tensors="pt")
with torch.no_grad():
    outputs = model(**inputs)
results = processor.post_process_grounded_object_detection(
    outputs, target_sizes=[img.size[::-1]], threshold=0.04
)
```

### YOLO Detection
```python
from ultralytics import YOLO
model = YOLO("yolov8x.pt")
results = model("/work/input.jpg", conf=0.005, iou=0.3, imgsz=1600, verbose=False)
```

### Blob Detection (for tiny/distant animals)
```python
import cv2
import numpy as np

img = cv2.imread("/work/input.jpg")
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
_, binary = cv2.threshold(gray, threshold_value, 255, cv2.THRESH_BINARY_INV)
# morphological cleanup
kernel = np.ones((3, 3), np.uint8)
binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
```
"""


@dataclass
class DetectionDeps:
    image_path: Path
    image_filename: str
    image_width: int
    image_height: int
    sandbox: Sandbox
    run_id: str
    # Mutable result storage — populated by submit_annotations tool
    result_annotations: list[dict[str, Any]] = field(default_factory=list)
    result_method_summary: str | None = None
    result_animal_type: str | None = None


class AnnotationInput(BaseModel):
    x: float
    y: float
    confidence: float | None = None
    label: str | None = None


detection_agent = Agent(
    deps_type=DetectionDeps,
    system_prompt=DETECTION_SYSTEM_PROMPT,
)


@detection_agent.tool
async def run_python(ctx: RunContext[DetectionDeps], code: str, description: str) -> str:
    """Execute Python code in the sandbox.

    The sandbox has access to opencv (cv2), numpy, pillow, scipy, scikit-image,
    and potentially ultralytics (YOLO) and transformers (OWLv2).
    The input image is at /work/input.jpg. Write output files to /work/.
    Print results to stdout for text summaries.

    Args:
        code: Python code to execute.
        description: Brief description of what this code does (for logging).
    """
    result: RunResult = await ctx.deps.sandbox.execute(code, timeout=settings.sandbox_timeout)
    parts = []
    if result.stdout:
        parts.append(f'stdout:\n{result.stdout}')
    if result.stderr:
        parts.append(f'stderr:\n{result.stderr}')
    parts.append(f'exit_code: {result.exit_code}')
    if result.output_files:
        parts.append(f'output_files: {", ".join(result.output_files)}')
    return '\n\n'.join(parts)


@detection_agent.tool
async def read_file(ctx: RunContext[DetectionDeps], path: str) -> str:
    """Read a file from the sandbox /work/ directory.

    Use this to inspect JSON outputs, check detection counts,
    or read any text file. Images (JPG/PNG) are returned as base64 data URIs
    that you can view directly.

    Args:
        path: File path relative to /work/ (e.g., 'output.json' or 'annotated.jpg').
    """
    return await ctx.deps.sandbox.read_file(path)


@detection_agent.tool
async def submit_annotations(
    ctx: RunContext[DetectionDeps],
    annotations_json: str,
    method_summary: str,
    animal_type: str | None = None,
) -> str:
    """Submit final detection annotations. Call this when detection is complete.

    Args:
        annotations_json: JSON array of objects with x, y (pixel coordinates),
            and optionally confidence (0-1) and label fields.
            Example: [{"x": 100, "y": 200, "confidence": 0.87}, ...]
        method_summary: Brief description of the detection method used.
        animal_type: Type of animal detected (e.g., "elk", "deer"), or null if unknown.
    """
    try:
        raw = json.loads(annotations_json)
    except json.JSONDecodeError as e:
        return f'Error: invalid JSON: {e}'

    if not isinstance(raw, list):
        return 'Error: annotations_json must be a JSON array'

    annotations = []
    for i, item in enumerate(raw):
        try:
            ann = AnnotationInput(**item)
            annotations.append(ann)
        except Exception as e:
            return f'Error parsing annotation {i}: {e}'

    # Convert to frontend annotation format
    frontend_annotations = []
    for i, ann in enumerate(annotations):
        frontend_annotations.append(
            {
                'id': i + 1,
                'x': round(ann.x),
                'y': round(ann.y),
                'bbox': None,
                'detection_confidence': ann.confidence,
                'classification_confidence': None,
                'source': 'agent',
                'label': ann.label or animal_type or 'animal',
                'state': 'auto-detected',
            }
        )

    # Store on deps for the SSE handler to pick up
    ctx.deps.result_annotations = frontend_annotations
    ctx.deps.result_method_summary = method_summary
    ctx.deps.result_animal_type = animal_type

    return f'Submitted {len(frontend_annotations)} annotations. Method: {method_summary}'


def create_sandbox_for_image(image_path: Path, run_id: str | None = None) -> SubprocessSandbox:
    """Create a sandbox work directory and copy the image into it."""
    if run_id is None:
        run_id = uuid.uuid4().hex[:12]
    work_dir = settings.sandbox_work_dir / run_id
    work_dir.mkdir(parents=True, exist_ok=True)
    dest = work_dir / f'input{image_path.suffix}'
    shutil.copy2(image_path, dest)
    return SubprocessSandbox(work_dir)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()
