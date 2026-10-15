"""Persistent, single-worker census jobs and review API for the full application."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from pydantic_ai import CallToolsNode
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.openai import OpenAIResponsesModelSettings
from pydantic_ai.usage import UsageLimits

from wildlife_counter.agent import now_iso
from wildlife_counter.classify import Classification
from wildlife_counter.classify_run import estimate_animal_px, run_classification
from wildlife_counter.config import settings
from wildlife_counter.counting_agent import Census, annotation, census_preview, counting_agent, crop_image
from wildlife_counter.db import get_db
from wildlife_counter.pricing import API_RATES

router = APIRouter(prefix='/api/counting')
tasks: dict[str, asyncio.Task] = {}
worker = asyncio.Semaphore(1)
TERMINAL = {'complete', 'error', 'cancelled', 'interrupted'}
# Classification-only jobs share the table but never answer "is this image counted?".
COUNT_RUNS_ONLY = "coalesce(json_extract(payload, '$.kind'), 'count') = 'count'"


async def initialize():
    db = await get_db(settings.db_path)
    try:
        await db.execute(
            'CREATE TABLE IF NOT EXISTS census_runs (id TEXT PRIMARY KEY, image_sha256 TEXT, payload TEXT)'
        )
        async with db.execute('PRAGMA table_info(census_runs)') as cursor:
            columns = {row['name'] for row in await cursor.fetchall()}
        if 'owner_key' not in columns:
            # Legacy runs have no provable owner. Keep them, but never share them by default.
            await db.execute('ALTER TABLE census_runs ADD COLUMN owner_key TEXT')
        await db.execute('CREATE INDEX IF NOT EXISTS census_owner_image ON census_runs(owner_key, image_sha256)')
        async with db.execute('SELECT payload FROM census_runs') as cursor:
            rows = await cursor.fetchall()
        for row in rows:
            run = json.loads(row['payload'])
            if run['status'] not in TERMINAL:
                run.update(
                    status='interrupted', error='Server restarted before this count finished.', completed_at=now_iso()
                )
                await db.execute('UPDATE census_runs SET payload=? WHERE id=?', (json.dumps(run), run['id']))
        await db.commit()
    finally:
        await db.close()


async def shutdown():
    active = list(tasks.values())
    for task in active:
        task.cancel()
    await asyncio.gather(*active, return_exceptions=True)
    tasks.clear()


async def save_run(run: dict):
    db = await get_db(settings.db_path)
    try:
        await db.execute(
            'INSERT INTO census_runs (id, image_sha256, payload, owner_key) VALUES (?, ?, ?, ?) '
            'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
            (run['id'], run['image_sha256'], json.dumps(run), run.get('owner_key')),
        )
        await db.commit()
    finally:
        await db.close()


async def load_run(run_id: str) -> dict:
    db = await get_db(settings.db_path)
    try:
        async with db.execute('SELECT payload FROM census_runs WHERE id=?', (run_id,)) as cursor:
            row = await cursor.fetchone()
        if row is None:
            raise HTTPException(404, 'Counting run not found')
        return json.loads(row['payload'])
    finally:
        await db.close()


def counting_owner(x_counting_client: Annotated[str | None, Header()] = None) -> str:
    """Anonymous browser credential until the app has authenticated accounts.

    Store only its hash, and require it for every run read or mutation.
    """
    try:
        token = uuid.UUID(x_counting_client or '')
        if token.version != 4:
            raise ValueError('Expected a random browser credential')
    except ValueError as exc:
        raise HTTPException(401, 'A private counting identity is required.') from exc
    return hashlib.sha256(str(token).encode()).hexdigest()


Owner = Annotated[str, Depends(counting_owner)]


async def owned_run(run_id: str, owner: str) -> dict:
    db = await get_db(settings.db_path)
    try:
        async with db.execute('SELECT payload FROM census_runs WHERE id=? AND owner_key=?', (run_id, owner)) as cur:
            row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, 'Counting run not found')
        return json.loads(row['payload'])
    finally:
        await db.close()


def enabled():
    if not settings.counting_enabled:
        raise HTTPException(503, 'AI counting is not enabled on this server.')


@router.get('/capabilities')
async def capabilities():
    return {
        'enabled': settings.counting_enabled,
        'model': settings.counting_model,
        'runner': settings.counting_runner,
        'method_version': 'spatial-census-v2-neighborhood-review',
        'detector_available': settings.counting_weights.is_file(),
    }


def estimated_cost(messages: list) -> float | None:
    """Standard API estimate, per request; output already includes reasoning tokens.

    Unknown model prices remain unknown, never silently become zero.
    """
    cost = 0.0
    for msg in messages:
        if not isinstance(msg, ModelResponse):
            continue
        rate = API_RATES.get(msg.model_name or '')
        if rate is None:
            return None
        u = msg.usage
        fresh = max(0, u.input_tokens - u.cache_read_tokens - u.cache_write_tokens)
        long = u.input_tokens > 272_000
        cost += (
            (fresh * rate[0] + u.cache_read_tokens * rate[1] + u.cache_write_tokens * rate[2]) * (2 if long else 1)
            + u.output_tokens * rate[3] * (1.5 if long else 1)
        ) / 1_000_000
    return round(cost, 6)


async def execute_run(run: dict, census: Census):
    try:
        async with worker:
            run.update(status='running', progress='Inspecting the image')
            await save_run(run)
            if run.get('runner') == 'codex':
                from wildlife_counter.counting_codex import run_codex

                await run_codex(run, census, save_run)
            else:
                prompt = (
                    f'Count elk in {run["image_filename"]}, {census.width}x{census.height}. '
                    'Start with get_ledger and source inspection; use the detector if useful. '
                    'Complete the full spatial review and finish_census. No reference annotations are supplied.'
                )
                async with counting_agent.iter(
                    prompt,
                    deps=census,
                    model=run['model'],
                    model_settings=OpenAIResponsesModelSettings(
                        openai_reasoning_effort='high', openai_service_tier='default'
                    ),
                    usage_limits=UsageLimits(
                        request_limit=settings.counting_request_limit,
                        output_tokens_limit=settings.counting_output_token_limit,
                    ),
                ) as agent_run:
                    try:
                        async for node in agent_run:
                            if isinstance(node, CallToolsNode):
                                for part in node.model_response.parts:
                                    if isinstance(part, ToolCallPart):
                                        run['progress'] = {
                                            'inspect_region': 'Inspecting image regions',
                                            'detect_candidates': 'Finding candidate animals',
                                            'record_region': 'Recording reviewed animals',
                                            'split_region': 'Taking a closer look at a crowded region',
                                            'view_crop': 'Checking image details',
                                            'finish_census': 'Finishing the count',
                                        }.get(part.tool_name, 'Reviewing the image')
                                    elif isinstance(part, TextPart) and part.content.strip():
                                        run['last_update'] = part.content[:1000]
                            run['usage'] = asdict(agent_run.usage())
                            run['estimated_cost_usd'] = estimated_cost(agent_run.all_messages())
                            run['regions_total'], run['regions_recorded'] = len(census.regions), len(census.records)
                            run['preview'] = census_preview(census.snapshot())
                            await save_run(run)
                    finally:
                        # Preserve usage and tool evidence even when a budget, provider, or cancellation stops the run.
                        run['usage'] = asdict(agent_run.usage())
                        run['estimated_cost_usd'] = estimated_cost(agent_run.all_messages())
                        (census.work_dir / 'messages.json').write_bytes(agent_run.all_messages_json())
            if not census.submitted:
                raise RuntimeError('The agent ended without completing the spatial review. Partial work was retained.')
            run['annotations'], run['uncertain'] = census.output()
            if run.get('classify'):
                await classify_count(run, census.work_dir)
            run.update(
                status='complete',
                method_summary=census.summary,
                progress='Ready for review',
                completed_at=now_iso(),
                accuracy_certified=False,
            )
    except asyncio.CancelledError:
        run.update(status='cancelled', completed_at=now_iso(), progress='Cancelled')
    except Exception as exc:
        run.update(status='error', error=str(exc), completed_at=now_iso(), progress='Count did not finish')
    finally:
        run.pop('preview', None)
        census.save()
        run['regions_total'], run['regions_recorded'] = len(census.regions), len(census.records)
        await save_run(run)
        tasks.pop(run['id'], None)


async def classify_count(run: dict, work_dir: Path):
    """Second phase of a "count & classify" run: label the census's own points. Never fails the count."""
    points = [dict(x=a['x'], y=a['y']) for a in run['annotations']]
    if not points:
        return
    run.update(progress='Classifying elk', phase='classifying')
    await save_run(run)
    c = Classification(
        Path(run['source_path']), work_dir / 'classify', run['width'], run['height'], points, estimate_animal_px(points)
    )
    classifier: dict = {'usage': {}, 'estimated_cost_usd': None}
    ok = await run_classification(c, classifier, settings.classification_model, settings.classification_effort)
    run['classification_cost_usd'] = classifier.get('estimated_cost_usd')
    if run['classification_cost_usd'] is not None and run.get('estimated_cost_usd') is not None:
        run['estimated_cost_usd'] = round(run['estimated_cost_usd'] + run['classification_cost_usd'], 6)
    if not ok:
        run['classification_error'] = (
            classifier.get('error') or 'Classification did not finish; markers stay unclassified.'
        )
        return
    for i, point in enumerate(run['annotations'], 1):
        if i in c.labels:
            point['category'] = c.labels[i]['cls']
    run['classified'] = True


class MarkerPoint(BaseModel):
    id: int
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)


async def execute_classification(run: dict, c: Classification):
    try:
        async with worker:
            run.update(status='running', progress='Classifying elk')
            await save_run(run)
            classifier: dict = {'usage': {}, 'estimated_cost_usd': None}
            ok = await run_classification(c, classifier, run['model'], settings.classification_effort)
            run['usage'], run['estimated_cost_usd'] = classifier['usage'], classifier['estimated_cost_usd']
            if not ok:
                raise RuntimeError(classifier.get('error') or 'Classification did not finish.')
            ids = [point['id'] for point in run['points']]
            run['classes'] = {str(ids[i - 1]): label['cls'] for i, label in c.labels.items()}
            run.update(status='complete', progress='Classes ready', completed_at=now_iso())
    except asyncio.CancelledError:
        run.update(status='cancelled', completed_at=now_iso(), progress='Cancelled')
    except Exception as exc:
        run.update(status='error', error=str(exc), completed_at=now_iso(), progress='Classification did not finish')
    finally:
        await save_run(run)
        tasks.pop(run['id'], None)


@router.post('/classify', status_code=202, dependencies=[Depends(enabled)])
async def create_classification(file: UploadFile, owner: Owner, points: Annotated[str, Form()]):
    """Classify the markers currently on the canvas, including ones the reviewer added by hand.

    `points` is a JSON list of {id, x, y} in original image pixels. The result's `classes` maps each
    marker id to a class id from the labeling app; markers never become cows by default.
    """
    if settings.counting_runner != 'codex':
        raise HTTPException(501, 'Classification runs on the subscription runner only.')
    content, width, height, suffix = await read_image(file)
    try:
        markers = TypeAdapter(list[MarkerPoint]).validate_json(points)
    except ValidationError as exc:
        raise HTTPException(422, f'Invalid points: {exc.errors()[:3]}') from exc
    if not 0 < len(markers) <= 5000:
        raise HTTPException(422, 'Send between 1 and 5000 markers.')
    if len({m.id for m in markers}) != len(markers):
        raise HTTPException(422, 'Marker ids must be unique.')
    if any(m.x >= width or m.y >= height for m in markers):
        raise HTTPException(422, 'Every marker must lie inside the image.')
    run_id = uuid.uuid4().hex
    work_dir = (settings.sandbox_work_dir / f'classify-{run_id}').resolve()
    work_dir.mkdir(parents=True)
    source = work_dir / f'input{suffix}'
    source.write_bytes(content)
    image_hash = hashlib.sha256(content).hexdigest()
    run = {
        'id': run_id,
        'kind': 'classify',
        'owner_key': owner,
        'image_filename': Path(file.filename or f'image{suffix}').name,
        'image_sha256': image_hash,
        'width': width,
        'height': height,
        'status': 'queued',
        'started_at': now_iso(),
        'model': settings.classification_model,
        'runner': settings.counting_runner,
        'points': [m.model_dump() for m in markers],
        'classes': {},
        'usage': {},
        'estimated_cost_usd': None,
        'progress': 'Waiting to classify',
        'source_path': str(source),
        'cost_basis': 'Standard API estimate; excludes hosting and taxes.',
    }
    xy = [dict(x=m.x, y=m.y) for m in markers]
    c = Classification(source, work_dir, width, height, xy, estimate_animal_px(xy))
    db = await get_db(settings.db_path)
    try:
        await db.execute(
            'INSERT INTO census_runs (id, image_sha256, payload, owner_key) VALUES (?, ?, ?, ?)',
            (run_id, image_hash, json.dumps(run), owner),
        )
        await db.commit()
    finally:
        await db.close()
    tasks[run_id] = asyncio.create_task(execute_classification(run, c))
    return public_run(run)


async def read_image(file: UploadFile) -> tuple[bytes, int, int, str]:
    """Validated upload bytes plus width, height and a file suffix for the stored copy."""
    content = await file.read(60 * 1024 * 1024 + 1)
    if len(content) > 60 * 1024 * 1024:
        raise HTTPException(413, 'Image exceeds 60 MB')
    try:
        with Image.open(io.BytesIO(content)) as im:
            width, height, fmt = im.width, im.height, im.format
            im.verify()
        # Sony survey JPEGs may contain MPF metadata and Pillow identifies them as MPO.
        # Count the primary frame, matching the browser's JPEG rendering, preserving original bytes.
        suffix = {'JPEG': '.jpg', 'MPO': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}.get(fmt or '')
        if not suffix or width * height > 100_000_000:
            raise ValueError('Use a JPEG, PNG, or WebP image with at most 100 megapixels.')
    except Exception as exc:
        raise HTTPException(400, f'Invalid image: {exc}') from exc
    return content, width, height, suffix


@router.post('/runs', status_code=202, dependencies=[Depends(enabled)])
async def create_run(file: UploadFile, owner: Owner, force: bool = False, classify: bool = False):
    content, width, height, suffix = await read_image(file)
    image_hash = hashlib.sha256(content).hexdigest()
    db = await get_db(settings.db_path)
    try:
        # Serialize lookup + creation, including concurrent requests from other tabs.
        # Reuse active work even with force; only explicit force bypasses completed results.
        await db.execute('BEGIN IMMEDIATE')
        async with db.execute(
            'SELECT payload FROM census_runs WHERE image_sha256=? AND owner_key=? AND '
            f'{COUNT_RUNS_ONLY} '
            "ORDER BY json_extract(payload, '$.started_at') DESC, rowid DESC",
            (image_hash, owner),
        ) as cursor:
            previous = [json.loads(row['payload']) for row in await cursor.fetchall()]
        active = next((run for run in previous if run['status'] in {'queued', 'running'}), None)
        complete = next((run for run in previous if run['status'] == 'complete'), None)
        cached = active or (complete if not force else None)
        if cached is not None:
            return public_run(cached)
        run_id = uuid.uuid4().hex
        work_dir = (settings.sandbox_work_dir / f'census-{run_id}').resolve()
        work_dir.mkdir(parents=True)
        source = work_dir / f'input{suffix}'
        source.write_bytes(content)
        run = {
            'id': run_id,
            'owner_key': owner,
            'image_filename': Path(file.filename or f'image{suffix}').name,
            'image_sha256': image_hash,
            'width': width,
            'height': height,
            'status': 'queued',
            'started_at': now_iso(),
            'model': settings.counting_model,
            'runner': settings.counting_runner,
            'annotations': [],
            'method_version': 'spatial-census-v2-neighborhood-review',
            'uncertain': [],
            'usage': {},
            'estimated_cost_usd': None,
            'progress': 'Waiting to count',
            'regions_total': 0,
            'regions_recorded': 0,
            'source_path': str(source),
            'cost_basis': 'Standard API estimate; excludes hosting and taxes.',
            'classify': classify,
        }
        census = Census(source, work_dir, width, height)
        run['preview'] = census_preview(census.snapshot())
        await db.execute(
            'INSERT INTO census_runs (id, image_sha256, payload, owner_key) VALUES (?, ?, ?, ?)',
            (run_id, image_hash, json.dumps(run), owner),
        )
        await db.commit()
        tasks[run_id] = asyncio.create_task(execute_run(run, census))
        return public_run(run)
    finally:
        await db.close()


def public_run(run: dict) -> dict:
    return {k: v for k, v in run.items() if k not in {'source_path', 'owner_key'}}


@router.get('/runs', dependencies=[Depends(enabled)])
async def list_runs(sha256: str, owner: Owner):
    db = await get_db(settings.db_path)
    try:
        async with db.execute(
            f'SELECT payload FROM census_runs WHERE image_sha256=? AND owner_key=? AND {COUNT_RUNS_ONLY} '
            "ORDER BY json_extract(payload, '$.started_at') DESC, rowid DESC",
            (sha256, owner),
        ) as cur:
            return [public_run(json.loads(row['payload'])) for row in await cur.fetchall()]
    finally:
        await db.close()


@router.get('/runs/{run_id}', dependencies=[Depends(enabled)])
async def get_run(run_id: str, owner: Owner):
    return public_run(await owned_run(run_id, owner))


@router.post('/runs/{run_id}/cancel', dependencies=[Depends(enabled)])
async def cancel_run(run_id: str, owner: Owner):
    run = await owned_run(run_id, owner)
    task = tasks.get(run_id)
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass  # A task cancelled before its coroutine starts cannot persist its own status.
        tasks.pop(run_id, None)
        run = await load_run(run_id)
    if run['status'] not in TERMINAL:
        run.update(status='cancelled', completed_at=now_iso())
        await save_run(run)
    return public_run(run)


class Decision(BaseModel):
    decision: Literal['accept', 'reject', 'pending']


@router.patch('/runs/{run_id}/uncertain/{point_id}', dependencies=[Depends(enabled)])
async def review_point(run_id: str, point_id: str, decision: Decision, owner: Owner):
    db = await get_db(settings.db_path)
    try:
        await db.execute('BEGIN IMMEDIATE')
        async with db.execute('SELECT payload FROM census_runs WHERE id=? AND owner_key=?', (run_id, owner)) as cur:
            row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, 'Run not found')
        run = json.loads(row['payload'])
        if run['status'] != 'complete':
            raise HTTPException(409, 'Wait for the count to finish')
        point = next((p for p in run['uncertain'] if p['id'] == point_id), None)
        if point is None:
            raise HTTPException(404, 'Uncertain point not found')
        # Idempotent and reversible; repeated acceptance cannot create duplicates.
        run['annotations'] = [a for a in run['annotations'] if a.get('uncertain_id') != point_id]
        if decision.decision == 'accept':
            a = annotation(max((a['id'] for a in run['annotations']), default=0) + 1, point['x'], point['y'])
            a.update(uncertain_id=point_id, reviewStatus='confirmed', source='user-reviewed-census')
            run['annotations'].append(a)
        point.update(decision=decision.decision, reviewed_at=now_iso())
        await db.execute('UPDATE census_runs SET payload=? WHERE id=?', (json.dumps(run), run_id))
        await db.commit()
        return public_run(run)
    finally:
        await db.close()


@router.get('/runs/{run_id}/uncertain/{point_id}/crop', dependencies=[Depends(enabled)])
async def uncertainty_crop(run_id: str, point_id: str, owner: Owner):
    run = await owned_run(run_id, owner)
    p = next((p for p in run['uncertain'] if p['id'] == point_id), None)
    if p is None:
        raise HTTPException(404, 'Uncertain point not found')
    c = Census(Path(run['source_path']), Path(run['source_path']).parent, run['width'], run['height'])
    # Include nearby same-image exemplars; scale the context to image resolution.
    radius = max(100, min(450, round(run['width'] / 24)))
    x, y = round(p['x']), round(p['y'])
    box = [max(0, x - radius), max(0, y - radius), min(c.width, x + radius), min(c.height, y + radius)]
    result = crop_image(c, box, run['annotations'] + [p])
    return Response(result.data, media_type='image/jpeg')


@router.get('/runs/{run_id}/export', dependencies=[Depends(enabled)])
async def export_run(run_id: str, owner: Owner):
    run = await owned_run(run_id, owner)
    if run['status'] != 'complete':
        raise HTTPException(409, 'Only completed counts can be exported')
    return {
        'version': 1,
        'image': {'filename': run['image_filename'], 'width': run['width'], 'height': run['height']},
        'annotations': run['annotations'],
        'census': public_run(run),
    }
