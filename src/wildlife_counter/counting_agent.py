"""Agent-driven census using bounded image tools; no agent-authored code execution."""

from __future__ import annotations

import asyncio
import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent, ModelRetry, RunContext

from wildlife_counter.config import settings


class Point(BaseModel):
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)


class PossiblePoint(Point):
    reason: str = Field(min_length=1)


def owns(box: list[int], x: float, y: float) -> bool:
    return box[0] <= x < box[2] and box[1] <= y < box[3]


@dataclass
class Census:
    image_path: Path
    work_dir: Path
    width: int
    height: int
    regions: dict[str, list[int]] = field(default_factory=dict)
    seen: set[str] = field(default_factory=set)
    checked: set[str] = field(default_factory=set)
    reconciled: set[str] = field(default_factory=set)
    records: dict[str, dict] = field(default_factory=dict)
    proposals: list[dict] = field(default_factory=list)
    submitted: bool = False
    summary: str = ''
    focus: list[int] | None = None
    # Method knobs for evals: initial tile size, and whether the cross-region final review is required.
    region_size: int = 1600
    final_review: bool = True
    # The prompt is written for elk; other species get an explicit override in the run instructions.
    species: str = 'elk'
    _pixels: Image.Image | None = field(default=None, repr=False, compare=False)

    def pixels(self) -> Image.Image:
        """Decode the source once per run; re-decoding a 60MP JPEG for every crop dominated CPU."""
        if self._pixels is None:
            with Image.open(self.image_path) as original:
                self._pixels = original.convert('RGB')
        return self._pixels

    def __post_init__(self):
        self.work_dir.mkdir(parents=True, exist_ok=True)
        if not self.regions:
            size = self.region_size
            for y in range(0, self.height, size):
                for x in range(0, self.width, size):
                    self.regions[f'r{y // size}c{x // size}'] = [
                        x,
                        y,
                        min(x + size, self.width),
                        min(y + size, self.height),
                    ]

    def snapshot(self) -> dict:
        return {
            'regions': self.regions,
            'seen': sorted(self.seen),
            'checked': sorted(self.checked),
            'reconciled': sorted(self.reconciled),
            'records': self.records,
            'submitted': self.submitted,
            'summary': self.summary,
            'focus': self.focus,
        }

    def save(self):
        pending = self.work_dir / 'ledger.tmp'
        pending.write_text(json.dumps(self.snapshot(), indent=2))
        pending.replace(self.work_dir / 'ledger.json')

    def output(self) -> tuple[list[dict], list[dict]]:
        annotations, uncertain = [], []
        for rid in self.regions:
            r = self.records.get(rid, {})
            for p in r.get('points', []):
                annotations.append(annotation(len(annotations) + 1, p['x'], p['y']))
            for p in r.get('uncertain', []):
                uncertain.append(dict(p, id=f'U{len(uncertain) + 1}', region=rid, decision='pending'))
        return annotations, uncertain

    def neighborhoods(self) -> dict[str, list[int]]:
        """Final review uses a different spatial grid and wider context than counting regions."""
        if not self.final_review:
            return {}
        points, uncertain = self.output()
        groups = {}
        for p in points + uncertain:
            x, y = int(p['x'] // 800) * 800, int(p['y'] // 800) * 800
            groups[f'n{y // 800}c{x // 800}'] = [
                max(0, x - 320),
                max(0, y - 320),
                min(self.width, x + 1120),
                min(self.height, y + 1120),
            ]
        return groups


def census_preview(data: dict) -> dict:
    """Read-only, replaceable visual progress, never final annotations or a certified count."""
    regions, points = [], []
    for rid, bounds in data['regions'].items():
        record = data['records'].get(rid)
        checked = record is not None and (rid in data['checked'] or (not record['points'] and not record['uncertain']))
        regions.append(
            dict(
                id=rid,
                bounds=bounds,
                status='checked'
                if checked
                else 'recorded'
                if record is not None
                else 'inspecting'
                if rid in data['seen']
                else 'pending',
            )
        )
        if record:
            for possible, key in [(False, 'points'), (True, 'uncertain')]:
                for i, point in enumerate(record[key]):
                    points.append(dict(id=f'{rid}:{key}:{i}', x=point['x'], y=point['y'], possible=possible))
    return dict(
        regions=regions,
        points=points,
        focus=data.get('focus'),
        phase='review' if all(r['status'] == 'checked' for r in regions) else 'counting',
        neighborhoods_checked=len(data.get('reconciled', [])),
    )


def annotation(identifier: int, x: float, y: float) -> dict:
    return dict(
        id=identifier,
        x=x,
        y=y,
        bbox=None,
        source='agent-census',
        label='unclassified elk',
        category='unclassified',
        state='auto-detected',
        reviewStatus='unconfirmed',
        detection_confidence=None,
        classification_confidence=None,
    )


PROMPT = """Count visible elk through a spatial census. Minimum cost subject to near-100%
accuracy is the objective. Never match an old count or claim independently verified accuracy.
Use only source pixels; do not guess hidden animals. Tools operate in ORIGINAL image coordinates.

1. get_ledger lists disjoint regions covering the entire image. inspect_region shows a region
with context, original-coordinate ticks, and a cyan ownership boundary. Count each torso only
in its owning region (left<=x<right, top<=y<bottom). Inspect every region, including empty ones.
2. detect_candidates optionally runs the elk-specific detector once. It is a proposer, not a
counter: shadows, heads and vegetation frequently receive high confidence. Inspect source crops
before deciding. You may inspect proposals for recall but must search unmarked areas too.
3. split_region subdivides dense areas. Aim for <=10 animals per region; recording >20 is
disallowed. view_crop gives additional native detail/context around overlaps or faint animals.
4. record_region stores torso points and separately unresolved POSSIBLE ADDITIONAL animals.
Use same-image comparisons: nearby elk at similar depth, relative size, pose, color, shadow
direction, and background texture. Two points over animal pixels may mark the SAME animal:
inspect nearby marker pairs together. Bedded animals may be tiny; never distance-suppress blindly.
5. inspect_region(view='review') after recording shows the actual points. Verify one point per
animal AND search unmarked pixels. Revise record_region and inspect again when needed.
6. After recording the entire image, get_ledger lists final neighborhoods and the
point-to-region mapping. inspect_neighborhood shows ALL current markers across region boundaries.
Review every final neighborhood. For every close group, trace each elk's rump/torso continuously
through its neck to its head and legs; a long diagonal neck or a disconnected visible body segment
is not an additional torso. In rear-facing standing elk, one white rump and its connected torso
often give a better identity anchor than brown shapes among overlapping necks. In bedded elk,
compare distinct torso outlines and heads to nearby bedded exemplars. Never merge by distance:
close animals can be distinct. Use unmarked view_crop to check pixels obscured by numbers.
Revise record_region for any duplicates/misses, review its overlay, then recheck final neighborhoods.
7. finish_census only succeeds after all regions have source inspection, recorded decisions,
and a final overlay inspection for populated regions. Empty regions still require inspection.
Use possible points for unresolved multiplicity, never claim that the count interval covers
unknown errors. Explain what remains uncertain. Zero is a valid result only after full review.

Keep tool arguments and progress explanations concise. Group independent inspections when
useful. There is no arbitrary Python tool; use the provided image functions. Animal classification
is separate: count unclassified elk without inventing age/sex. Existing annotations are not supplied.
"""


def prompt_for(species: str) -> str:
    """The census prompt for a species (plural, e.g. 'ducks'); elk get the original prompt unchanged."""
    if species == 'elk':
        return PROMPT
    edits = [
        ('Count visible elk through', f'Count visible {species} through'),
        (
            '2. detect_candidates optionally runs the elk-specific detector once. It is a proposer, not a\n'
            'counter: shadows, heads and vegetation frequently receive high confidence. Inspect source crops\n'
            'before deciding. You may inspect proposals for recall but must search unmarked areas too.',
            f'2. detect_candidates is an elk-only detector and does not apply to {species}; do not call it.\n'
            'Find every animal by inspecting source pixels directly.',
        ),
        ('4. record_region stores torso points', '4. record_region stores body-center points'),
        ('nearby elk at similar depth', f'nearby {species} at similar depth'),
        ('Bedded animals may be tiny', 'Distant or resting animals may be tiny'),
        (
            "For every close group, trace each elk's rump/torso continuously\n"
            'through its neck to its head and legs; a long diagonal neck or a disconnected visible body segment\n'
            'is not an additional torso. In rear-facing standing elk, one white rump and its connected torso\n'
            'often give a better identity anchor than brown shapes among overlapping necks. In bedded elk,\n'
            'compare distinct torso outlines and heads to nearby bedded exemplars.',
            'For every close group, trace each body outline separately; a head, a raised wing, a\n'
            'reflection or a shadow is not an additional animal. Compare distinct body outlines and heads\n'
            'to clear nearby exemplars of similar size. Count animals cut off by the image edge once if\n'
            'their body is visibly inside the frame.',
        ),
        ('Count each torso only', 'Count each body only'),
        (
            'count unclassified elk without inventing age/sex.',
            f'count all {species} without inventing species, age or sex.',
        ),
    ]
    text = PROMPT
    for old, new in edits:
        if old not in text:
            raise RuntimeError(f'Census prompt changed; update prompt_for: {old[:40]!r}')
        text = text.replace(old, new)
    return text


counting_agent = Agent(deps_type=Census, system_prompt=PROMPT, retries=3)


@counting_agent.tool
def get_ledger(ctx: RunContext[Census]) -> dict:
    """Get source dimensions, original-coordinate region bounds, and review progress."""
    c = ctx.deps
    return {
        'width': c.width,
        'height': c.height,
        'regions': c.regions,
        'recorded': list(c.records),
        'checked': sorted(c.checked),
        'proposals': len(c.proposals),
        'final_neighborhoods': c.neighborhoods() if len(c.records) == len(c.regions) else {},
        'reconciled': sorted(c.reconciled),
        'points_by_region': c.records if len(c.records) == len(c.regions) else {},
    }


def crop_image(c: Census, box: list[int], points: list[dict], boundary: list[int] | None = None) -> BinaryContent:
    x0, y0, x1, y1 = box
    im = c.pixels().crop((x0, y0, x1, y1))
    # Preserve native detail; magnify small crops without inventing detail.
    scale = min(3.0, max(1.0, 900 / max(im.size)))
    im = im.resize((round(im.width * scale), round(im.height * scale)))
    draw = ImageDraw.Draw(im)
    if boundary:
        draw.rectangle([(boundary[i] - (x0 if i % 2 == 0 else y0)) * scale for i in range(4)], outline='cyan', width=2)
    for x in range(math.ceil(x0 / 100) * 100, x1, 100):
        draw.text(((x - x0) * scale + 2, 2), str(x), fill='yellow', stroke_width=1, stroke_fill='black')
    for y in range(math.ceil(y0 / 100) * 100, y1, 100):
        draw.text((2, (y - y0) * scale + 2), str(y), fill='yellow', stroke_width=1, stroke_fill='black')
    for i, p in enumerate(points, 1):
        if owns(box, p['x'], p['y']):
            x, y = (p['x'] - x0) * scale, (p['y'] - y0) * scale
            color = 'orange' if p.get('reason') else '#00ff40'
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), outline=color, width=1)
            draw.text((x + 7, y - 12), str(p.get('id', i)), fill=color, stroke_width=1, stroke_fill='black')
    out = io.BytesIO()
    im.save(out, format='JPEG', quality=95)
    return BinaryContent(data=out.getvalue(), media_type='image/jpeg')


@counting_agent.tool(sequential=True)
def inspect_region(
    ctx: RunContext[Census], region: str, view: Literal['source', 'proposals', 'review'] = 'source'
) -> BinaryContent:
    """Inspect a region with nearby context. Source is unmarked; review shows recorded points."""
    c = ctx.deps
    if region not in c.regions:
        raise ModelRetry('Unknown region; use get_ledger.')
    b = c.regions[region]
    box = [max(0, b[0] - 120), max(0, b[1] - 120), min(c.width, b[2] + 120), min(c.height, b[3] + 120)]
    points = []
    if view == 'source':
        c.seen.add(region)
    elif view == 'proposals':
        points = c.proposals
    else:
        if region not in c.records:
            raise ModelRetry('Record the region before inspecting its review overlay.')
        for r in c.records.values():
            points.extend(r['points'] + r['uncertain'])
        c.checked.add(region)
    result = crop_image(c, box, points, b)
    c.focus = b
    c.save()
    return result


@counting_agent.tool
def view_crop(ctx: RunContext[Census], left: int, top: int, right: int, bottom: int) -> BinaryContent:
    """Inspect an unmarked source crop for detailed overlap and same-image context comparisons."""
    c = ctx.deps
    if not (0 <= left < right <= c.width and 0 <= top < bottom <= c.height):
        raise ModelRetry('Crop bounds must be inside the original image.')
    if right - left > 2000 or bottom - top > 2000:
        raise ModelRetry('Use a crop no larger than 2000 pixels per side.')
    box = [left, top, right, bottom]
    result = crop_image(c, box, [])
    c.focus = box
    c.save()
    return result


@counting_agent.tool(sequential=True)
def inspect_neighborhood(ctx: RunContext[Census], neighborhood: str) -> BinaryContent:
    """Final cross-region review: trace nearby numbered markers to distinct animal bodies."""
    c = ctx.deps
    if len(c.records) != len(c.regions):
        raise ModelRetry('Record every region before final neighborhood reconciliation.')
    box = c.neighborhoods().get(neighborhood)
    if box is None:
        raise ModelRetry('Unknown final neighborhood; use get_ledger.')
    points, uncertain = c.output()
    result = crop_image(c, box, points + uncertain)
    c.reconciled.add(neighborhood)
    c.focus = box
    c.save()
    return result


@counting_agent.tool(sequential=True)
def split_region(ctx: RunContext[Census], region: str) -> dict:
    """Replace a dense region with four (thin strips: two) disjoint children; prior decisions must be redone."""
    c = ctx.deps
    if region not in c.regions:
        raise ModelRetry('Unknown region.')
    left, top, right, bottom = c.regions[region]
    width, height = right - left, bottom - top
    if max(width, height) < 100:
        raise ModelRetry('Region is already very small; inspect it with view_crop.')
    del c.regions[region]
    c.records.pop(region, None)
    c.checked.discard(region)
    c.seen.discard(region)
    c.reconciled.clear()
    c.submitted = False
    mx, my = (left + right) // 2, (top + bottom) // 2
    if width < 100:
        # A thin edge strip can still hold many animals: split along its long side only.
        boxes = [[left, top, right, my], [left, my, right, bottom]]
    elif height < 100:
        boxes = [[left, top, mx, bottom], [mx, top, right, bottom]]
    else:
        boxes = [[left, top, mx, my], [mx, top, right, my], [left, my, mx, bottom], [mx, my, right, bottom]]
    children = {f'{region}.{i}': box for i, box in enumerate(boxes)}
    c.regions.update(children)
    c.focus = None
    c.save()
    return children


@counting_agent.tool(sequential=True)
def record_region(
    ctx: RunContext[Census], region: str, points: list[Point], uncertain: list[PossiblePoint], notes: str
) -> str:
    """Replace this region's decisions using original-image torso coordinates, after source inspection."""
    c = ctx.deps
    if region not in c.regions or region not in c.seen:
        raise ModelRetry('Inspect the source region first.')
    if len(points) + len(uncertain) > 20:
        raise ModelRetry('Too dense: split_region and review smaller regions.')
    if not notes.strip():
        raise ModelRetry('Record brief evidence, including the unmarked-area recall check.')
    all_points = points + uncertain
    if any(not owns(c.regions[region], p.x, p.y) for p in all_points):
        raise ModelRetry('Every point must belong to this region core, not its context margin.')
    coords = [(p.x, p.y) for p in all_points]
    if len(coords) != len(set(coords)):
        raise ModelRetry('Identical point coordinates are duplicated.')
    c.focus = c.regions[region]
    c.records[region] = {
        'points': [p.model_dump() for p in points],
        'uncertain': [p.model_dump() for p in uncertain],
        'notes': notes,
    }
    c.checked.discard(region)
    c.reconciled.clear()
    c.submitted = False
    c.save()
    noun = 'elk' if c.species == 'elk' else c.species
    return f'Recorded {len(points)} {noun} and {len(uncertain)} possible extras; inspect review overlay next.'


@counting_agent.tool(sequential=True)
def finish_census(ctx: RunContext[Census], summary: str) -> dict:
    """Submit only after full spatial review. A valid empty census is distinct from no submission."""
    c = ctx.deps
    pending = [
        rid
        for rid in c.regions
        if rid not in c.records
        or rid not in c.seen
        or ((c.records[rid]['points'] or c.records[rid]['uncertain']) and rid not in c.checked)
    ]
    if pending:
        raise ModelRetry(f'Unfinished regions: {pending}')
    remaining = set(c.neighborhoods()) - c.reconciled
    if remaining:
        raise ModelRetry(f'Final cross-region duplicate/miss review required: {sorted(remaining)}')
    if not summary.strip():
        raise ModelRetry('Explain the method and residual ambiguity.')
    c.submitted, c.summary = True, summary
    c.save()
    points, uncertain = c.output()
    return {'count': len(points), 'possible_additional': len(uncertain), 'accuracy_certified': False}


def propose(image_path: Path, width: int, height: int) -> list[dict] | None:
    """Raw elk-detector proposals (center, box width, score) on overlapping crops; None if unavailable."""
    try:
        import ultralytics
    except ImportError:
        return None
    model = getattr(ultralytics, 'YOLO')(str(settings.counting_weights))
    points = []
    with Image.open(image_path) as im:
        for y in range(0, height, 400):
            for x in range(0, width, 400):
                left, top = max(0, x - 120), max(0, y - 120)
                crop = im.crop((left, top, min(width, x + 520), min(height, y + 520))).convert('RGB')
                result = model.predict(crop, conf=0.05, iou=0.7, imgsz=640, device='cpu', verbose=False)[0]
                for b, score in zip(result.boxes.xyxy.tolist(), result.boxes.conf.tolist(), strict=True):
                    px, py = (b[0] + b[2]) / 2 + left, (b[1] + b[3]) / 2 + top
                    if x <= px < min(width, x + 400) and y <= py < min(height, y + 400):
                        points.append(
                            dict(id=len(points) + 1, x=px, y=py, confidence=score, size=max(b[2] - b[0], b[3] - b[1]))
                        )
    return points


@counting_agent.tool(sequential=True)
async def detect_candidates(ctx: RunContext[Census]) -> dict:
    """Run the optional elk detector once on overlapping 640px crops. Raw proposals are review aids."""
    c = ctx.deps
    if c.species != 'elk':
        return {'available': False, 'reason': f'The detector is elk-only; inspect source pixels for {c.species}.'}
    if not settings.counting_weights.is_file():
        return {'available': False, 'reason': 'No elk detector weights configured; use direct source inspection.'}
    if (c.work_dir / 'proposals.json').exists():
        return {'available': True, 'count': len(c.proposals), 'cached': True}

    points = await asyncio.to_thread(propose, c.image_path, c.width, c.height)
    if points is None:
        return {'available': False, 'reason': 'Detector dependencies are not installed; inspect source pixels.'}
    c.proposals = points
    (c.work_dir / 'proposals.json').write_text(json.dumps(points))
    return {'available': True, 'count': len(points), 'note': 'Inspect proposals view; duplicates are retained.'}
