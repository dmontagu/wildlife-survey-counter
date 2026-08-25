# Wildlife Survey Counter — Project Guide

## Repository Structure

```
src/
  wildlife_counter/             Python backend package (FastAPI + blob detection)
    __init__.py
    server.py                   API routes, static file serving, SPA fallback
    detect.py                   Blob detection pipeline (threshold, morphology, shadow-aware NMS)
    config.py                   pydantic-settings (env prefix: WSC_)
  frontend/                     React 19 + TypeScript annotation review UI (see src/frontend/CLAUDE.md)
storage/                        All gitignored runtime data
  samples/                      Sample images (was data/)
  uploads/                      User uploads
  models/                       Model weights
  output/                       Research output
research/                       Experimental scripts — OWLv2, CountGD, HerdNet, Grounding DINO
plans/                          Implementation plans, technical research notes
project/                        Project-level reference docs (overview, branding, product strategy)
```

`project/` contains living documents about what the project is and who it's for. `plans/` contains tactical implementation details. See `project/overview.md` for the full project context.

## Running Locally

```bash
make install  # uv sync + npm install
make dev      # Backend on :8100, frontend dev server on :5173 (with proxy)
```

The frontend Vite config proxies `/api`, `/samples`, and `/uploads` to the backend at localhost:8100.

## Backend

- **Framework**: FastAPI, served by uvicorn, instrumented with Logfire. Telemetry is only sent when
  `LOGFIRE_TOKEN` is set (`send_to_logfire='if-token-present'`); otherwise instrumentation is a no-op.
- **Entry point**: `wildlife_counter.server:app` (or `python -m wildlife_counter.server`, which accepts
  `--host`, `--port`, and `--reload`). Auto-reload is off by default — `make dev` and the dev Docker image
  pass `--reload`; production does not.
- **Config**: `wildlife_counter.config.Settings` — env prefix `WSC_` (e.g., `WSC_SAMPLES_DIR`, `WSC_PORT`,
  `WSC_RELOAD`)
- **Routes**:
  - `GET /api/health` — health check
  - `GET /api/images` — list available images from `storage/samples/` and `storage/uploads/`
  - `POST /api/upload` — upload an image, returns `{filename, size}`
  - `POST /api/detect/{filename}` — run blob detection, returns annotations array
  - `GET /samples/*`, `GET /uploads/*` — static file serving for images
  - `GET /*` — SPA fallback (serves `src/frontend/dist/index.html`)
- **Detection**: `wildlife_counter.detect` implements blob detection tuned for dark-on-light aerial imagery. Key parameters: threshold (auto-estimated from brightness), area_min/max (scaled by image resolution), shadow-aware NMS

## Frontend

See `src/frontend/CLAUDE.md` for detailed frontend architecture. Key points:

- React 19 + TypeScript, Tailwind CSS v4, shadcn/ui
- Vite 7 with `@vitejs/plugin-react-swc`
- Canvas-based rendering with RAF + dirty-flag optimization
- State via React Context + useReducer with undo/redo patches
- Modifier-key-driven interaction (no tool modes)
- localStorage persistence for annotations (prefix: `wsc:`)

## Dependencies

- **Base** (in Docker): fastapi, logfire, numpy, opencv-python-headless, pillow, pydantic-settings, python-multipart, uvicorn
- **ML optional** (`pip install .[ml]`): torch, transformers, ultralytics, sam2, etc. — only needed for research scripts, not for the deployed app

## Docker & Deployment

- Multi-stage Dockerfile: Node build → Python slim runtime
- Only needs `libglib2.0-0` (not libgl1) for opencv-python-headless
- Health check at `GET /api/health`
- `make docker-build` / `make docker-run`

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
- **Blob detection for demo** — no PyTorch needed, keeps Docker image small and fast
- **ML deps are optional** — the heavy ML stack (torch, transformers, etc.) is in `[project.optional-dependencies.ml]`
- **Confidence slider** with histogram is critical UX — different models produce different score ranges
- **pydantic-settings** for configuration — env-configurable paths, replaces hardcoded constants
- **Logfire** for observability — instrument_fastapi + spans on detection pipeline
