# Wildlife Survey Counter — Project Guide

## Repository Structure

```
src/
  wildlife_counter/             Python backend package (FastAPI + blob detection)
    __init__.py
    server.py                   API routes, static file serving, SPA fallback
    detect.py                   Blob detection pipeline (threshold, morphology, shadow-aware NMS)
    agent.py                    pydantic-ai detection agent — system prompt, tools, deps
    sandbox.py                  Sandbox ABC + SubprocessSandbox (runs agent code in a work dir)
    db.py                       aiosqlite storage for detection runs (create/list/get/update)
    config.py                   pydantic-settings (env prefix: WSC_)
  frontend/                     React 19 + TypeScript labeling UI (see src/frontend/CLAUDE.md)
storage/                        All gitignored runtime data (see storage/README.md)
  samples/                      Sample images (was data/)
  uploads/                      User uploads
  sandbox/                      Per-run agent working directories
  models/                       Model weights
  output/                       Research output
  wsc.db                        SQLite database of agent detection runs
research/                       Experimental scripts — blob, CountGD, HerdNet, Grounding DINO
scripts/                        One-off evaluation / batch-annotation scripts (YOLO, SAHI, cross-validation)
```

## Running Locally

```bash
make install  # uv sync + npm install
make dev      # Backend on :8100, frontend dev server on :5173 (with proxy)
```

The frontend Vite config proxies `/api`, `/samples`, and `/uploads` to the backend at localhost:8100.

## Backend

- **Framework**: FastAPI, served by uvicorn, instrumented with Logfire. Telemetry is only sent when a
  Logfire token is configured — `LOGFIRE_TOKEN`, or a `.logfire/` credentials file from the Logfire CLI
  (`send_to_logfire='if-token-present'`); otherwise instrumentation is a no-op.
- **Entry point**: `wildlife_counter.server:app` (or `python -m wildlife_counter.server`, which accepts
  `--host`, `--port`, and `--reload`/`--no-reload`). Auto-reload is off by default — `make dev` and the dev Docker image
  pass `--reload`; production does not.
- **Config**: `wildlife_counter.config.Settings` — env prefix `WSC_`. Fields: `samples_dir`, `uploads_dir`, `frontend_dist_dir`, `db_path`, `sandbox_work_dir`, `detection_model`, `sandbox_timeout`, `max_tool_calls`, `port`, `host`, `reload` (so `WSC_SAMPLES_DIR`, `WSC_DB_PATH`, `WSC_SANDBOX_WORK_DIR`, `WSC_DETECTION_MODEL`, `WSC_SANDBOX_TIMEOUT`, `WSC_MAX_TOOL_CALLS`, `WSC_PORT`, `WSC_RELOAD`, …)
- **Routes**:
  - `GET /api/health` — health check
  - `GET /api/images` — list available images from `storage/samples/` and `storage/uploads/`
  - `POST /api/upload` — upload an image, returns `{filename, basePath, size}`
  - `POST /api/detect/{filename}` — run blob detection, returns `{annotations, method, count}`
  - `POST /api/agent-detect/{filename}` — run the detection agent, streams SSE (`start`, `text`, `tool_call`, `annotations`, `complete`, `error`)
  - `GET /api/detections` — list detection runs (optional `?image=` filter)
  - `GET /api/detections/{run_id}` — fetch one detection run
  - `GET /samples/*`, `GET /uploads/*` — static file serving for images
  - `GET /*` — SPA fallback (serves `src/frontend/dist/index.html`)
- **Used by the UI**: only `GET /api/images`, and only in dev (`SHOW_DEV_SAMPLES`). `/api/upload`, `/api/detect`, `/api/agent-detect`, and `/api/detections` have no frontend caller today
- **Detection**: `wildlife_counter.detect` implements blob detection tuned for dark-on-light aerial imagery. Key parameters: threshold (auto-estimated from brightness), area_min/max (scaled by image resolution), shadow-aware NMS
- **Agent detection**: `wildlife_counter.agent` runs a pydantic-ai agent (`WSC_DETECTION_MODEL`, default `anthropic:claude-sonnet-5`) with `run_python` / `read_file` / `submit_annotations` tools against a `SubprocessSandbox` work dir; runs are recorded in SQLite via `wildlife_counter.db`

## Frontend

See `src/frontend/CLAUDE.md` for detailed frontend architecture. Key points:

- React 19 + TypeScript, Tailwind CSS v4, shadcn/ui
- Vite 7 with `@vitejs/plugin-react-swc`
- Canvas-based rendering with RAF + dirty-flag optimization
- State via React Context + useReducer with undo/redo patches
- Modifier-key-driven interaction (no tool modes)
- localStorage persistence for annotations, recent images, and UI preferences (prefix: `wsc:`); opened image files are stored as blobs in IndexedDB (`wsc-browser-images`), so the app works with no backend at all
- Build-time flags: `VITE_SHOW_SAMPLE_IMAGES` (`src/frontend/src/config.ts` — set to `false` to hide the dev sample list, which is dev-only regardless), plus `VITE_BACKEND_URL`, `VITE_BASE_PATH`, and `VITE_APP_COMMIT_HASH` in `vite.config.ts`

## Dependencies

- **Base**: aiosqlite, fastapi, logfire, numpy, opencv-python-headless, pillow, pydantic-ai, pydantic-settings, python-multipart, uvicorn
- **ML optional** (`pip install .[ml]`): torch, transformers, ultralytics, sam2, etc. — needed by the `research/` and `scripts/` scripts, and by the code the detection agent runs in its sandbox; the labeling UI never needs them

## Docker & Deployment

- Multi-stage Dockerfile: Node build → Python slim runtime
- Default build is headless: base deps only, so it only needs `libglib2.0-0` for opencv-python-headless
- `ARG WITH_ML` (default `false`) gates the optional agent sandbox: `WITH_ML=true` adds the `[ml]`
  extra, the GL/X11 libs full `opencv-python` links against (`libgl1` — *not* `libgl1-mesa-glx`,
  which no longer exists on Debian 13), and pre-downloaded yolov8x + OWLv2 weights. That image is
  several GB.
- The project is not pip-installed in the image: `uv sync --no-install-project` plus
  `ENV PYTHONPATH=/app/src`, and every `uv run` passes `--no-sync` (otherwise uv re-syncs and tries
  to build the project, which needs files the image doesn't carry)
- `HEALTHCHECK` in the image hits `GET /api/health` via python urllib (no curl in slim)
- `make docker-build` / `make docker-run`, or `make docker-build WITH_ML=true`
- CI builds the default image and smoke-tests `/api/health` on every PR

## Docker Development

```bash
make up            # Start stack in Docker (auto-starts Traefik if needed)
make down          # Stop the stack (Traefik keeps running for other stacks)
make logs          # Follow all logs
make status        # Show URLs for all services in this stack
make dev           # Alternative: run bare-metal without Docker

# Traefik management (shared across all projects)
make traefik-up    # Start Traefik (idempotent)
make traefik-down  # Stop Traefik (stops routing for ALL stacks)
make traefik-logs  # View Traefik logs
```

Each stack is isolated via `COMPOSE_PROJECT_NAME=wsc-<branch>`. The branch name is
auto-derived from git. Services are accessible at:
- **Frontend**: `http://wsc-<branch>.localhost`
- **Backend API**: `http://api.wsc-<branch>.localhost`
- **Non-HTTP services** (postgres, etc.): use `docker compose port <service> <port>` to discover the assigned host port

**Convention for worktrees / parallel work:**
When creating worktrees for parallel feature work, each worktree's `make up` will
start a separate, isolated stack. The stack name is derived from the git branch, prefixed
with `wsc-` to avoid collisions with other projects. Set `COMPOSE_PROJECT_NAME` explicitly
if needed:

```bash
COMPOSE_PROJECT_NAME=wsc-my-feature make up
# → http://wsc-my-feature.localhost
# → http://api.wsc-my-feature.localhost
```

Traefik dashboard: http://localhost:8080 (shows all running stacks).

## Key Design Decisions

- **Point annotations** (not bounding boxes) — the counting ecosystem (HerdNet, LILA BC datasets) uses points
- **Blob detection is dependency-light** — pure OpenCV + numpy, no PyTorch; the agent sandbox is where the optional ML extras get used
- **ML deps are optional** — the heavy ML stack (torch, transformers, etc.) is in `[project.optional-dependencies.ml]`
- **Confidence slider** with histogram — `ConfidenceSlider.tsx` exists but is not mounted anywhere today; it matters again once model detections feed the UI, because different models produce different score ranges
- **pydantic-settings** for configuration — env-configurable paths, replaces hardcoded constants
- **Logfire** for observability — instrument_fastapi + spans on detection pipeline
