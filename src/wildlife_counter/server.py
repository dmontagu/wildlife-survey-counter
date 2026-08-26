import json
import logging
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import logfire
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import StreamingResponse

from wildlife_counter.config import settings
from wildlife_counter.detect import detect_animals

# Sends only when a Logfire token is configured (LOGFIRE_TOKEN, or a .logfire/ credentials file
# written by the Logfire CLI); otherwise instrumentation is a no-op.
logfire.configure(send_to_logfire='if-token-present')

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from wildlife_counter.db import init_db

    # Ensure directories exist
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    settings.samples_dir.mkdir(parents=True, exist_ok=True)
    settings.sandbox_work_dir.mkdir(parents=True, exist_ok=True)

    # Initialize database
    await init_db(settings.db_path)

    yield


app = FastAPI(lifespan=lifespan)
logfire.instrument_fastapi(app, excluded_urls='/api/health')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


def _resolve_image_path(filename: str) -> Path | None:
    """Look up an image in uploads then samples directories."""
    for d in [settings.uploads_dir, settings.samples_dir]:
        candidate = d / filename
        if candidate.is_file():
            return candidate
    return None


@app.get('/api/health')
async def health():
    return {'status': 'ok'}


@app.get('/api/images')
async def list_images():
    """List image files with enough metadata for the UI to reopen them safely."""
    images: list[dict[str, str]] = []
    for source, directory, base_path in [
        ('sample', settings.samples_dir, '/samples/'),
        ('upload', settings.uploads_dir, '/uploads/'),
    ]:
        if not directory.exists():
            continue
        for file in directory.iterdir():
            if not file.is_file() or file.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            images.append(
                {
                    'filename': file.name,
                    'basePath': base_path,
                    'source': source,
                    'url': f'{base_path}{file.name}',
                }
            )
    return sorted(images, key=lambda image: (image['source'], image['filename']))


@app.post('/api/upload')
async def upload_image(file: UploadFile):
    """Upload an image file. Returns the filename to use for subsequent requests."""
    if not file.filename:
        raise HTTPException(status_code=400, detail='No filename provided')

    suffix = Path(file.filename).suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f'Unsupported file type: {suffix}')

    stem = Path(file.filename).stem
    unique = secrets.token_hex(4)
    filename = f'{stem}_{unique}{suffix}'
    dest = settings.uploads_dir / filename

    content = await file.read()
    dest.write_bytes(content)

    return {'filename': filename, 'basePath': '/uploads/', 'size': len(content)}


@app.post('/api/detect/{filename}')
async def run_detection(filename: str):
    """Run blob detection on an image. Returns annotations in the frontend schema."""
    image_path = _resolve_image_path(filename)
    if image_path is None:
        raise HTTPException(status_code=404, detail=f'Image not found: {filename}')

    annotations = detect_animals(image_path)
    return {
        'annotations': annotations,
        'method': 'blob',
        'count': len(annotations),
    }


# --- Agent Detection Endpoint (SSE) ---


def _sse_event(event: str, data: dict) -> str:
    """Format a server-sent event."""
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'


@app.post('/api/agent-detect/{filename}')
async def agent_detect(filename: str, request: Request):
    """Run AI agent detection on an image. Returns SSE stream of progress events."""
    from PIL import Image as PILImage
    from pydantic_ai import BinaryContent, CallToolsNode, ModelRequestNode, UserPromptNode
    from pydantic_ai.messages import TextPart, ToolCallPart
    from pydantic_ai.usage import UsageLimits
    from pydantic_graph import End

    from wildlife_counter.agent import DetectionDeps, create_sandbox_for_image, detection_agent, now_iso
    from wildlife_counter.db import get_db, insert_detection_run, update_detection_run

    image_path = _resolve_image_path(filename)
    if image_path is None:
        return StreamingResponse(
            iter([_sse_event('error', {'message': f'Image not found: {filename}'})]),
            media_type='text/event-stream',
        )

    # Get image dimensions
    with PILImage.open(image_path) as img:
        img_width, img_height = img.size

    run_id = uuid.uuid4().hex[:12]
    sandbox = create_sandbox_for_image(image_path, run_id)

    async def event_generator() -> AsyncIterator[str]:
        db = await get_db(settings.db_path)
        try:
            await sandbox.start()

            # Insert initial DB row
            await insert_detection_run(
                db,
                {
                    'id': run_id,
                    'image_filename': filename,
                    'status': 'running',
                    'started_at': now_iso(),
                    'completed_at': None,
                    'method_summary': None,
                    'animal_type': None,
                    'annotations': None,
                    'error': None,
                },
            )

            yield _sse_event('start', {'run_id': run_id})

            # Build deps
            deps = DetectionDeps(
                image_path=image_path,
                image_filename=filename,
                image_width=img_width,
                image_height=img_height,
                sandbox=sandbox,
                run_id=run_id,
            )

            # Build user message with image
            image_data = image_path.read_bytes()
            suffix = image_path.suffix.lower()
            media_type = 'image/jpeg' if suffix in ('.jpg', '.jpeg') else f'image/{suffix.lstrip(".")}'
            user_message = [
                f'Detect and count animals in this image ({filename}, {img_width}x{img_height}px).',
                BinaryContent(data=image_data, media_type=media_type),
            ]

            # Run agent with iteration
            async with detection_agent.iter(
                user_message,
                deps=deps,
                model=settings.detection_model,
                usage_limits=UsageLimits(request_limit=settings.max_tool_calls),
            ) as agent_run:
                async for node in agent_run:
                    # Check if client disconnected
                    if await request.is_disconnected():
                        break

                    if isinstance(node, UserPromptNode):
                        yield _sse_event('text', {'text': 'Analyzing image...'})

                    elif isinstance(node, ModelRequestNode):
                        pass  # Internal request, no user-facing event

                    elif isinstance(node, CallToolsNode):
                        # Extract text and tool calls from model response
                        for part in node.model_response.parts:
                            if isinstance(part, TextPart) and part.content.strip():
                                yield _sse_event('text', {'text': part.content})
                            elif isinstance(part, ToolCallPart):
                                tool_args = part.args_as_dict()
                                if part.tool_name == 'run_python':
                                    desc = tool_args.get('description', 'Running code...')
                                    yield _sse_event('tool_call', {'tool': 'run_python', 'description': desc})
                                elif part.tool_name == 'read_file':
                                    yield _sse_event(
                                        'tool_call',
                                        {
                                            'tool': 'read_file',
                                            'description': f'Reading {tool_args.get("path", "file")}',
                                        },
                                    )
                                elif part.tool_name == 'submit_annotations':
                                    yield _sse_event(
                                        'tool_call',
                                        {
                                            'tool': 'submit_annotations',
                                            'description': 'Submitting final annotations',
                                        },
                                    )

                    elif isinstance(node, End):
                        pass  # Handled below

                # After iteration: check for annotations
                annotations = deps.result_annotations
                method_summary = deps.result_method_summary
                animal_type = deps.result_animal_type

                if annotations:
                    yield _sse_event(
                        'annotations',
                        {
                            'annotations': annotations,
                            'method_summary': method_summary or '',
                            'count': len(annotations),
                        },
                    )

                # Update DB
                await update_detection_run(
                    db,
                    run_id,
                    status='complete',
                    completed_at=now_iso(),
                    method_summary=method_summary,
                    animal_type=animal_type,
                    annotations=annotations,
                )

                yield _sse_event(
                    'complete',
                    {
                        'run_id': run_id,
                        'count': len(annotations) if annotations else 0,
                    },
                )

        except Exception as e:
            error_msg = str(e)
            logfire.error('Agent detection failed', error=error_msg, run_id=run_id)
            try:
                await update_detection_run(
                    db,
                    run_id,
                    status='error',
                    completed_at=now_iso(),
                    error=error_msg,
                )
            except Exception:
                pass
            yield _sse_event('error', {'message': error_msg})

        finally:
            await sandbox.stop()
            await db.close()

    return StreamingResponse(event_generator(), media_type='text/event-stream')


# --- Detection Runs List Endpoints ---


@app.get('/api/detections')
async def list_detections(image: str | None = None):
    """List detection runs, optionally filtered by image filename."""
    from wildlife_counter.db import get_db, list_detection_runs

    db = await get_db(settings.db_path)
    try:
        runs = await list_detection_runs(db, image_filename=image)
        return runs
    finally:
        await db.close()


@app.get('/api/detections/{run_id}')
async def get_detection(run_id: str):
    """Get a specific detection run by ID."""
    from wildlife_counter.db import get_db, get_detection_run

    db = await get_db(settings.db_path)
    try:
        run = await get_detection_run(db, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail='Detection run not found')
        return run
    finally:
        await db.close()


# --- Static Files & SPA Fallback (must be last) ---

# Mount samples directory for serving images
settings.samples_dir.mkdir(parents=True, exist_ok=True)
app.mount('/samples', StaticFiles(directory=str(settings.samples_dir)), name='samples')

# Mount uploads directory
settings.uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount('/uploads', StaticFiles(directory=str(settings.uploads_dir)), name='uploads')

# Serve frontend - must be last
if settings.frontend_dist_dir.exists():
    app.mount('/assets', StaticFiles(directory=str(settings.frontend_dist_dir / 'assets')), name='assets')

    @app.get('/{path:path}')
    async def serve_frontend(path: str):
        """Serve the frontend SPA."""
        file_path = settings.frontend_dist_dir / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(settings.frontend_dist_dir / 'index.html')


class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return '/api/health' not in record.getMessage()


# Custom log config so the filter survives uvicorn's reload (child process gets this config)
UVICORN_LOG_CONFIG: dict = {
    'version': 1,
    'disable_existing_loggers': False,
    'filters': {'health': {'()': _HealthCheckFilter}},
    'formatters': {
        'default': {'fmt': '%(levelprefix)s %(message)s', 'use_colors': None, '()': 'uvicorn.logging.DefaultFormatter'},
        'access': {
            'fmt': '%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
            'use_colors': None,
            '()': 'uvicorn.logging.AccessFormatter',
        },
    },
    'handlers': {
        'default': {'class': 'logging.StreamHandler', 'formatter': 'default', 'stream': 'ext://sys.stderr'},
        'access': {
            'class': 'logging.StreamHandler',
            'formatter': 'access',
            'stream': 'ext://sys.stdout',
            'filters': ['health'],
        },
    },
    'loggers': {
        'uvicorn': {'handlers': ['default'], 'level': 'INFO', 'propagate': False},
        'uvicorn.error': {'level': 'INFO'},
        'uvicorn.access': {'handlers': ['access'], 'level': 'INFO', 'propagate': False},
    },
}


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=settings.port)
    parser.add_argument('--host', type=str, default=settings.host)
    parser.add_argument(
        '--reload',
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable uvicorn's auto-reloader (dev only); overrides WSC_RELOAD",
    )
    args = parser.parse_args()
    uvicorn.run(
        'wildlife_counter.server:app',
        host=args.host,
        port=args.port,
        reload=settings.reload if args.reload is None else args.reload,
        log_config=UVICORN_LOG_CONFIG,
    )


if __name__ == '__main__':
    main()
