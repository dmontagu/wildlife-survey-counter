from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent, RunContext

from wildlife_counter.config import settings
from wildlife_counter.sandbox import RunResult, Sandbox, SubprocessSandbox

DETECTION_SYSTEM_PROMPT = """\
You count visible individual animals in survey photographs. Aim for less than
1% count error, but never claim this accuracy without an independently audited
reference. Existing labels, previous counts, and model proposals can be wrong.

## Workspace and tools

Python runs in a per-run working directory using the server's interpreter.
Locate the original with next(Path('.').glob('input.*')). Use RELATIVE paths
for crops and output files: there is no /work mount. opencv, numpy, and Pillow
are available; check imports before choosing optional ML packages. read_file
returns actual image content for JPG/PNG crops, so inspect your work visually.

## Counting procedure

1. Inspect the full image for animal size, terrain, shadows, density, and
   peripheral animals. A whole-image visual estimate is not a count.
2. Partition the ENTIRE image into disjoint core rectangles with context
   margins. Assign an animal to exactly one core by its torso center using
   left <= x < right and top <= y < bottom. Context margins are only for
   recognizing partial animals; never count them twice.
3. View native-resolution crops. Subdivide dense cores until each view has
   roughly 5-10 animals. Preserve a transform from displayed pixels back to
   source pixels, and keep a ledger of reviewed regions (including empty ones).
4. Generate proposals as useful: tiled elk-specific detection if available,
   exemplar/color/shape segmentation on suitable backgrounds, or direct visual
   pointing. Choose per-image methods. Model scores are not calibrated accuracy.
5. Precision pass: inspect every animal marker. Distinguish body from shadow,
   head from body, vegetation from animals, and separate overlapping animals.
   Compare ambiguous shapes with clear elk AND background objects in this same
   photograph at similar depth: relative size, color, pose, shadow direction,
   and texture matter. Keep enough surrounding pixels to make that comparison.
   Review close marker pairs together to catch two points on one animal.
   Do not suppress distinct neighbors simply because their centers are close.
6. Recall pass: inspect UNMARKED source crops of ALL regions, including places
   where the detector found nothing. Check lying animals, calves, image edges,
   tree cover, and dense clusters. Record unresolved animals separately.
7. Compare the independent spatial count with the proposal count, then inspect
   every disagreement at higher resolution. Generate a final numbered overlay
   and verify one marker per visible animal. Reconcile counts and coordinates.
8. Submit only after reviewing the entire image. Explain the method, residual
   ambiguity, and any incompletely inspected areas. Do not describe agreement
   between your own passes as independently validated accuracy.

## Rules

- Neither undercounting nor overcounting is preferred: minimize both.
- Do not adjust a count to match a prior label or initial visual guess.
- Count visible animals even in a close-up or a non-aerial photograph. A zero
  count means no visible target animals, not an unsupported image style.
- Do not hallucinate hidden animals, use image generation to resolve details,
  or infer extra individuals solely from shadows or antlers.
- Keep source coordinates inside the original image bounds. Submit one point
  at each torso center, with label 'unclassified elk' unless species differs.
- Keep classification separate from counting. An animal can be countable even
  when age, sex, or antler class is unclear.
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
    x: float = Field(allow_inf_nan=False, ge=0)
    y: float = Field(allow_inf_nan=False, ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
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
    Find the input with Path(".").glob("input.*"). Write output files using relative paths.
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
async def read_file(ctx: RunContext[DetectionDeps], path: str) -> str | BinaryContent:
    """Read a file from the sandbox working directory.

    Use this to inspect JSON outputs, check detection counts,
    or read any text file. Images (JPG/PNG) are returned as multimodal image content
    that you can inspect visually.

    Args:
        path: File path relative to the working directory (e.g., 'output.json' or 'annotated.jpg').
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
            if ann.x >= ctx.deps.image_width or ann.y >= ctx.deps.image_height:
                return f'Error: annotation {i} lies outside the image'
            annotations.append(ann)
        except Exception as e:
            return f'Error parsing annotation {i}: {e}'

    # Convert to frontend annotation format
    frontend_annotations = []
    for i, ann in enumerate(annotations):
        frontend_annotations.append(
            {
                'id': i + 1,
                'x': min(ctx.deps.image_width - 1, round(ann.x)),
                'y': min(ctx.deps.image_height - 1, round(ann.y)),
                'bbox': None,
                'detection_confidence': ann.confidence,
                'classification_confidence': None,
                'source': 'agent',
                'label': ann.label or animal_type or 'animal',
                'category': 'unclassified',
                'reviewStatus': 'unconfirmed',
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
    dest = work_dir / f'input{image_path.suffix.lower()}'
    shutil.copy2(image_path, dest)
    return SubprocessSandbox(work_dir)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()
