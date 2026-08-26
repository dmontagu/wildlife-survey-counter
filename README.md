# Wildlife Survey Counter

Automated wildlife counting from aerial survey photography, with a review UI for correcting and exporting annotations. Built for state wildlife agency biologists who count animals from aerial photos — primarily elk on snow in Montana, but designed to work for any species.

## Quick Start

```bash
# Install dependencies
make install

# Start dev servers (backend on :8100, frontend on :5173)
make dev
```

Open http://localhost:5173, pick a sample image or upload your own, and click **Detect Animals**.

## Project Structure

```
src/
  wildlife_counter/   Python backend (FastAPI) — detection + image serving
  frontend/           React + TypeScript annotation review UI
storage/              Runtime data: samples, uploads, models, output (gitignored)
research/             Experimental detection scripts (OWLv2, CountGD, HerdNet, etc.)
plans/                Implementation plans, technical research notes
project/              Project reference docs (branding, product strategy)
```

## How It Works

1. **Upload** an aerial photo (or pick a sample image)
2. **Auto-detect** animals using blob detection (dark-on-light contrast, tuned for snow backgrounds)
3. **Review** detections in the annotation UI — confirm, reject, or add missed animals
4. **Export** annotations as JSON for model training or reporting

The annotation UI supports deep zoom, keyboard-driven workflows, undo/redo, bulk operations, and a confidence slider with histogram.

## Tech Stack

- **Backend**: Python 3.13, FastAPI, OpenCV (headless), Pillow, Logfire
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, HTML Canvas
- **Build**: Vite 6, uv (Python), npm (Node)
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

The default image is headless and lean — FastAPI, OpenCV (headless), and the built frontend, with
no PyTorch and no model weights. It exposes a Docker healthcheck on `GET /api/health`.

To also install the optional ML stack (torch, transformers, ultralytics) and pre-download the
weights used by the agent sandbox, build with `WITH_ML=true`. The resulting image is several GB, and
CI only validates its system-library stage — the full ML build is not exercised automatically:

```bash
make docker-build WITH_ML=true
# or: docker build --build-arg WITH_ML=true -t wildlife-survey-counter .
```

## Detection Methods

| Method | Best For | Status |
|--------|----------|--------|
| **Blob detection** | Tiny animals on snow/high-contrast backgrounds | Integrated |
| **OWLv2 + YOLO** | Medium animals, mixed scenes | Research scripts |
| **HerdNet** | Dense herds, point-based counting | Planned (fine-tuning) |
| **CountGD** | Zero-shot counting with text prompts | Research scripts |

See `plans/automated-labeling.md` for the full detection strategy.
