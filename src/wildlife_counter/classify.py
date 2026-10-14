"""Classify already-counted elk (cow, calf, spike, brow-tined bull, ...) from batches of full-resolution crops.

Counting and classification are separate: this takes points from a finished census and only
labels them. The model sees each batch as one magnified crop with small numbered tags beside
each elk (tags never cover heads or antlers), can zoom on single animals, and must record a
class for every elk in a batch. Host code enforces that every batch was viewed and recorded.
"""

from __future__ import annotations

import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image, ImageDraw
from pydantic import BaseModel, Field

ElkClass = Literal['cow', 'calf', 'unclassified-antlerless', 'spike', 'brow-tined', 'bull', 'unclassified']

# Same ids as the labeling app's categories (src/frontend/src/config.ts), so results load directly.
CLASSES: dict[str, str] = {
    'cow': 'adult female: no antlers, full adult body and long face',
    'calf': 'young of the year: no antlers, clearly smaller body and shorter face/neck than nearby cows',
    'unclassified-antlerless': 'no antlers, head clearly visible, but cow vs calf is uncertain',
    'spike': 'yearling bull: unbranched single-beam antlers (spikes), no tines',
    'brow-tined': 'mature bull: branched antlers with brow tines (the first tine, just above the eye)',
    'bull': 'antlers visible but spike vs brow-tined cannot be determined',
    'unclassified': 'head/antlers not visible enough to judge (lying down, facing away, obscured, too small)',
}

PROMPT = f"""Classify every already-counted elk in an aerial survey photo. The animals are already
located; do not add or remove animals, only label each numbered elk with exactly one class:

{chr(10).join(f'- {k}: {v}' for k, v in CLASSES.items())}

Rules:
- Use only visible evidence. Never infer antlers you cannot see; a mature bull that has shed its
  antlers, or whose head is hidden, is 'unclassified' unless body evidence is unambiguous.
- Calves are judged by size and face shape RELATIVE TO NEARBY ADULTS in the same photo.
- Prefer an 'unclassified' class over a guess. Over-confident wrong classes are worse than unclassified.
- Each numbered tag sits just up-left of a small dot on that elk's torso; the dot marks the animal.

Tools: get_batches lists batches; view_batch(batch) shows one magnified crop with numbered tags;
view_animal(id) zooms on one elk when its head or antlers need a closer look (use it sparingly);
record_classes(batch, labels) stores a class for EVERY elk in the batch; finish(summary) when all
batches are recorded. Keep notes short. Be efficient: one view per batch is usually enough.
"""


class Label(BaseModel):
    id: int
    cls: ElkClass
    note: str = Field(default='', max_length=200)


@dataclass
class Classification:
    image_path: Path
    work_dir: Path
    width: int
    height: int
    points: list[dict]
    animal_px: float
    batch_size: int = 12
    viewed: set[str] = field(default_factory=set)
    labels: dict[int, dict] = field(default_factory=dict)
    recorded: set[str] = field(default_factory=set)
    submitted: bool = False
    summary: str = ''
    _pixels: Image.Image | None = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        self.work_dir.mkdir(parents=True, exist_ok=True)

    @property
    def scale(self) -> float:
        """Show an elk at ~110px (antlers need detail): magnify small elk up to 6x, shrink large ones to 0.5x."""
        return min(6.0, max(0.5, 110 / max(1.0, self.animal_px)))

    def batches(self) -> dict[str, list[int]]:
        # Group by source tiles small enough that a magnified crop stays under ~1800px, then chunk.
        tile = max(1.0, 1500 / self.scale)
        cells: dict[tuple[int, int], list[int]] = {}
        for i, p in enumerate(self.points):
            cells.setdefault((int(p['y'] // tile), int(p['x'] // tile)), []).append(i)
        out: dict[str, list[int]] = {}
        for key in sorted(cells):
            ids = sorted(cells[key], key=lambda i: (self.points[i]['y'], self.points[i]['x']))
            for j in range(0, len(ids), self.batch_size):
                out[f'b{len(out) + 1}'] = [i + 1 for i in ids[j : j + self.batch_size]]
        return out

    def pixels(self) -> Image.Image:
        if self._pixels is None:
            with Image.open(self.image_path) as im:
                self._pixels = im.convert('RGB')
        return self._pixels

    def render(self, ids: list[int], margin: float) -> bytes:
        pts = [self.points[i - 1] for i in ids]
        pad = margin * self.animal_px
        box = (
            max(0, math.floor(min(p['x'] for p in pts) - pad)),
            max(0, math.floor(min(p['y'] for p in pts) - pad)),
            min(self.width, math.ceil(max(p['x'] for p in pts) + pad)),
            min(self.height, math.ceil(max(p['y'] for p in pts) + pad)),
        )
        im = self.pixels().crop(box)
        s = self.scale if len(ids) > 1 else max(self.scale, min(10.0, 320 / max(im.size)))
        im = im.resize((round(im.width * s), round(im.height * s)), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(im)
        tag = 22
        for i, p in zip(ids, pts, strict=True):
            x, y = (p['x'] - box[0]) * s, (p['y'] - box[1]) * s
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill='#00ff40', outline='black')
            # Tag sits just up-left of the dot with a short leader line, so it is unambiguous which
            # elk it names while staying off the torso (heads/antlers extend beyond the dot).
            tx, ty = x - tag - 14, y - tag - 14
            draw.line((tx + tag * 0.6, ty + tag, x - 3, y - 3), fill='#00ff40', width=2)
            draw.text(
                (max(0, tx), max(0, ty)), str(i), fill='#00ff40', stroke_width=3, stroke_fill='black', font_size=tag
            )
        out = io.BytesIO()
        im.save(out, format='JPEG', quality=92)
        return out.getvalue()

    def save(self):
        state = dict(
            viewed=sorted(self.viewed),
            recorded=sorted(self.recorded),
            labels={str(k): v for k, v in self.labels.items()},
            submitted=self.submitted,
            summary=self.summary,
        )
        tmp = self.work_dir / 'classes.tmp'
        tmp.write_text(json.dumps(state, indent=1))
        tmp.replace(self.work_dir / 'classes.json')

    def load(self):
        path = self.work_dir / 'classes.json'
        if path.exists():
            state = json.loads(path.read_text())
            self.viewed, self.recorded = set(state['viewed']), set(state['recorded'])
            self.labels = {int(k): v for k, v in state['labels'].items()}
            self.summary = state['summary']
            batches = self.batches()
            # Recheck completion in host code, independently of the model's claim.
            self.submitted = bool(state['submitted']) and all(
                b in self.recorded and all(i in self.labels for i in ids) for b, ids in batches.items()
            )

    def write_source(self):
        (self.work_dir / 'source.json').write_text(
            json.dumps(
                dict(
                    image_path=str(self.image_path),
                    width=self.width,
                    height=self.height,
                    points=self.points,
                    animal_px=self.animal_px,
                    batch_size=self.batch_size,
                )
            )
        )

    @classmethod
    def from_source(cls, work_dir: Path) -> Classification:
        cfg = json.loads((work_dir / 'source.json').read_text())
        c = cls(
            Path(cfg['image_path']),
            work_dir,
            cfg['width'],
            cfg['height'],
            cfg['points'],
            cfg['animal_px'],
            cfg['batch_size'],
        )
        c.load()
        return c


class ToolError(Exception):
    """A recoverable tool misuse, reported back to the model."""


def get_batches(c: Classification) -> dict:
    batches = c.batches()
    return {
        'animals': len(c.points),
        'batches': {b: len(ids) for b, ids in batches.items()},
        'recorded': sorted(c.recorded),
        'remaining': [b for b in batches if b not in c.recorded],
        'classes': CLASSES,
    }


def view_batch(c: Classification, batch: str) -> bytes:
    ids = c.batches().get(batch)
    if ids is None:
        raise ToolError('Unknown batch; use get_batches.')
    c.viewed.add(batch)
    c.save()
    return c.render(ids, margin=1.2)


def view_animal(c: Classification, animal: int) -> bytes:
    if not 1 <= animal <= len(c.points):
        raise ToolError('Unknown animal id.')
    return c.render([animal], margin=2.5)


def record_classes(c: Classification, batch: str, labels: list[Label]) -> str:
    ids = c.batches().get(batch)
    if ids is None:
        raise ToolError('Unknown batch; use get_batches.')
    if batch not in c.viewed:
        raise ToolError('View the batch before recording it.')
    given = [lab.id for lab in labels]
    if sorted(given) != sorted(ids):
        missing, extra = sorted(set(ids) - set(given)), sorted(set(given) - set(ids))
        raise ToolError(f'Label every elk in this batch exactly once. Missing: {missing}; not in batch: {extra}')
    for lab in labels:
        c.labels[lab.id] = dict(cls=lab.cls, note=lab.note)
    c.recorded.add(batch)
    c.save()
    remaining = [b for b in c.batches() if b not in c.recorded]
    return f'Recorded {len(labels)} elk. Remaining batches: {len(remaining)}'


def finish(c: Classification, summary: str) -> dict:
    remaining = [b for b in c.batches() if b not in c.recorded]
    if remaining:
        raise ToolError(f'Unrecorded batches: {remaining}')
    c.submitted, c.summary = True, summary
    c.save()
    counts: dict[str, int] = {}
    for lab in c.labels.values():
        counts[lab['cls']] = counts.get(lab['cls'], 0) + 1
    return {'classified': len(c.labels), 'by_class': counts}
