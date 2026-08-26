# Wildlife Survey Counter

A manual labeling workspace for aerial wildlife survey photography: mark every animal in a photo, classify it, and export the counts. Built for state wildlife agency biologists who count animals from aerial photos — primarily elk on snow in Montana, but designed to work for any species.

The deployed app is at [wildlifesurveycounter.com](https://wildlifesurveycounter.com). Your images and annotations never leave your browser — there is no server, no upload, and no account. (The page does load Cloudflare Web Analytics, which records anonymous page views.)

## Quick Start

```bash
# Install dependencies
make install

# Start dev servers (backend on :8100, frontend on :5173)
make dev
```

Open http://localhost:5173, drag an aerial photo into the window (or use **Open image**), then click empty canvas to drop a marker on each animal.

## Project Structure

```
src/
  wildlife_counter/   Python backend (FastAPI) — image serving, blob detection, agent-driven detection
  frontend/           React + TypeScript labeling UI — this is what ships to GitHub Pages
storage/              Runtime data: samples, uploads, agent sandbox dirs, SQLite db (gitignored)
research/             Experimental detection scripts (blob, CountGD, Grounding DINO, HerdNet)
scripts/              One-off evaluation and batch-annotation scripts (YOLO, SAHI, cross-validation)
```

## How It Works

1. **Open** an aerial photo — drag it into the window or use **Open image**. The image is kept in IndexedDB and its annotations in localStorage, both local to your browser.
2. **Mark** each animal — click empty canvas to drop a point marker.
3. **Classify** — Cow / Bull / Spike from the on-image controls, or `E` to cycle. `C` confirms the selection, `U` unconfirms it, Backspace deletes it.
4. **Export** — **Export Results** downloads a review JPG and an annotations JSON together.

The UI supports deep zoom, keyboard-driven workflows, undo/redo, and bulk selection (box select, `Cmd/Ctrl+A`, and `Shift+Cmd/Ctrl+drag` to select and confirm in one gesture).

### The backend is optional

The deployed site is frontend-only — no server, no upload, no account. The FastAPI backend in `src/wildlife_counter/` is for local development: it serves sample images to the dev server and exposes two experimental detection endpoints, `POST /api/detect/{filename}` (blob detection) and `POST /api/agent-detect/{filename}` (agent-driven detection, which needs an Anthropic API key; the `[ml]` extras give the code it runs more to work with). Neither is wired into the UI today.

Run the backend on localhost only: it has no authentication and executes agent-generated code in an unsandboxed subprocess. See [#7](https://github.com/dmontagu/wildlife-survey-counter/issues/7).

## Tech Stack

- **Backend**: Python 3.13, FastAPI, OpenCV (headless), Pillow, pydantic-ai, SQLite (aiosqlite), Logfire
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, HTML Canvas
- **Build**: Vite 7, uv (Python), npm (Node)
- **Deploy**: GitHub Pages for the frontend, Docker for local/full-stack use

## Development

```bash
make install    # Install all dependencies
make dev        # Start both servers with hot reload
make build      # Build frontend for production
make serve      # Build + serve via FastAPI (single server)
make typecheck  # Type-check Python + TypeScript
make format     # Format Python + TypeScript
make clean      # Remove build artifacts
```

### Docker

```bash
make docker-build   # Build image
make docker-run     # Build + run locally on :8100
```

## Detection Methods

| Method | Best For | Status |
|--------|----------|--------|
| **Blob detection** | Tiny animals on snow/high-contrast backgrounds | Backend endpoint (`POST /api/detect/{filename}`), not used by the UI |
| **Agent-driven detection** | Choosing an approach per image, then running it | Experimental backend endpoint (`POST /api/agent-detect/{filename}`) |
| **Grounding DINO / CountGD** | Zero-shot counting with text prompts | Research scripts |
| **HerdNet** | Dense herds, point-based counting | Research script (zero-shot transfer test) |
| **YOLO (+ SAHI tiling)** | Medium animals, mixed scenes | Evaluation scripts in `scripts/` |

The `research/` and `scripts/` directories hold the exploratory versions of these; none of them run in the deployed app.
