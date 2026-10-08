# Wildlife Survey Counter

A manual labeling workspace for aerial wildlife survey photography: mark every animal in a photo, classify it, and export the counts. Built for state wildlife agency biologists who count animals from aerial photos — primarily elk on snow in Montana, but designed to work for any species.

The deployed app is at [wildlifesurveycounter.com](https://wildlifesurveycounter.com). Your images and annotations never leave your browser — there is no server, no upload, and no account. (The page does load Cloudflare Web Analytics, which records anonymous page views.)

## Quick Start

For the image-by-image counting experiments, audited point sets, and current
results, see [the independent census report](research/independent-census.md).

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
3. **Classify** — Cow, Calf, Unclassified antlerless, Spike bull, Brow-tined bull, Unclassified bull, or Unclassified elk, from the on-image palette or each class's letter (`E` cycles through them; `?` opens the full shortcut reference). `Enter` confirms the selection, `Shift+Enter` marks it unconfirmed, and Backspace deletes it.
4. **Export** — **Export Results** downloads a review JPG and an annotations JSON together.

The UI supports deep zoom, keyboard-driven workflows, undo/redo, and bulk selection (box select, `Cmd/Ctrl+A`, and `Shift+Cmd/Ctrl+drag` to select and confirm in one gesture).

### The backend is optional

The deployed site is frontend-only — no server, no upload, no account. The FastAPI backend in `src/wildlife_counter/` serves local samples and an opt-in **Count elk** action. It runs an image-review agent in the background and delivers ordinary unconfirmed markers directly to the canvas. The older experimental endpoints, `POST /api/detect/{filename}` and `POST /api/agent-detect/{filename}`, remain separate from this workflow.

Run the backend on localhost only: it has no authentication and executes agent-generated code in an unsandboxed subprocess. See [#7](https://github.com/dmontagu/wildlife-survey-counter/issues/7).

### Test AI counting with a Codex subscription

Sign in to the installed Codex CLI using ChatGPT (`codex login`; verify with
`codex login status`). The default counting runner forces ChatGPT authentication
and removes API keys from its child environment; it does not fall back to paid
API calls. It consumes your subscription usage limits. The tested CLI is 0.153.4.

From the repository root, start the local server:

```bash
WSC_COUNTING_ENABLED=true WSC_COUNTING_RUNNER=codex \
  WSC_DB_PATH=storage/local-census-test.db \
  WSC_SAMPLES_DIR=data/elk_images_from_fwp \
  .venv/bin/python -m wildlife_counter.server --host 127.0.0.1 --port 8110
```

In another terminal:

```bash
cd src/frontend
VITE_AI_COUNTING=true VITE_BACKEND_URL=http://127.0.0.1:8110 \
  npm run dev -- --host 127.0.0.1 --port 5180
```

Open **http://127.0.0.1:5180**, load a photo (or choose **Dev Samples** from the
image menu), and click **Count elk**. A compact toolbar status tracks the background
run; starting a count keeps a new upload in Recent Work even before it has any labels.
You can switch images or leave and return. Counts are cached by your private browser
identity plus the original file's SHA-256: reopening or reuploading the same file (even renamed) reuses its saved result,
and simultaneous requests share any active run. A newer failed attempt never hides an
older successful result. The toolbar shows **Count saved** once complete; it cannot
accidentally start another analysis. An intentional fresh analysis is available only
through `POST /api/counting/runs?force=true` with the image file; this retains prior
results and still reconnects to your active run. All counting requests must include
the browser's `X-Counting-Client` credential. Failed counts without a saved result
can be retried normally. Completed results appear automatically
as the existing unconfirmed markers. Possible animals use those same markers and can
be confirmed or removed on the canvas. Their coordinates remain separate from definite
animals in the raw server result, but both contribute to the UI's unconfirmed total.
There is no separate counting modal, overlay image, or apply step in the normal flow.
While counting, a live grid shows regions still to inspect, checked regions, and a
subtle pulse on the latest inspected area. Hollow temporary markers display the
agent's current detections and update when it revises them. They are a read-only
preview: excluded from saved annotations, exports, totals, and undo history. The
preview disappears on completion, cancellation, or failure, and follows pan/zoom.
Reduced-motion preferences disable the animation. One agent reviews each image;
it may batch inspection calls, but regions are not independent parallel counters.

Delivery is undoable. If you have reviewed labels or annotations changed during the run, the app preserves them
and offers an inline **Use AI labels** action instead of overwriting edits.
Results are bound to the original image hash and dimensions. Completion receipts are
written only after annotation persistence, and undoing a result prevents it from
being automatically reapplied on refresh. Class predictions are preserved when supplied;
the current agent counts unclassified elk and does not yet predict cow/bull/etc.

There are no accounts yet: a random credential in `wsc:counting-client:v1` identifies
one browser profile across tabs and restarts. Separate profiles do not share counts,
even for identical files. Every run read, cancellation, review, and export checks
ownership; the database stores the credential's hash. People using the same browser
profile share its identity. Clearing browser storage loses access to that profile's
server counts. Replace this anonymous identity with authenticated user IDs when adding
accounts. Pre-identity runs remain in SQLite with no owner and are excluded from the
cache; they must be explicitly assigned by the local operator, never claimed by the
first visitor or shared automatically.
To attach known local runs to your profile, find `wsc:counting-client:v1` in that
browser's developer tools under Local Storage, then run:

```bash
.venv/bin/python scripts/assign_census_owner.py --db storage/local-census-test.db --run RUN_ID
```

Paste the credential at the hidden prompt (do not send it in chat). Repeat `--run`
for each known run. This only attaches the saved results; it never runs the model
or transfers counts already owned by another profile.


The counter uses bounded native image/crop/detector tools through a local MCP
server, with disjoint region ownership and completion checks. It does not need
Monty or agent-authored Python for this first implementation. Native inference
runs in the server's Python environment; the existing YOLO checkpoint is optional
and is only a source of proposals. Install `ultralytics` in that environment if
you want proposals. The workflow works without detector weights.

Run records persist in SQLite; source files, spatial ledgers, and tool traces live
in `storage/sandbox/census-<run-id>/`. Failed/interrupted counts cannot be applied
as completed results. The local worker processes one run at a time. Keep this
trusted local test server on loopback; subscription authentication is not a
deployment design for a shared service. Counting is disabled by default and its
button is omitted from production builds unless `VITE_AI_COUNTING=true`.

The optional `WSC_COUNTING_RUNNER=api` path uses Pydantic AI and an explicitly
configured API provider. It has not been tested with paid calls. Do not select it
for subscription-only experiments. Displayed subscription costs are approximate
API equivalents, not charges; see [local results and limits](research/independent-census.md).

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
| **Agent spatial census** | Reviewable per-image counts with explicit uncertainty | Local full-app workflow (`/api/counting`), Codex subscription runner tested |
| **Blob detection** | Tiny animals on snow/high-contrast backgrounds | Backend endpoint (`POST /api/detect/{filename}`), not used by the UI |
| **Agent-driven detection** | Choosing an approach per image, then running it | Experimental backend endpoint (`POST /api/agent-detect/{filename}`) |
| **Grounding DINO / CountGD** | Zero-shot counting with text prompts | Research scripts |
| **HerdNet** | Dense herds, point-based counting | Research script (zero-shot transfer test) |
| **YOLO (+ SAHI tiling)** | Medium animals, mixed scenes | Evaluation scripts in `scripts/` |

The `research/` and `scripts/` directories hold the exploratory versions of these; none of them run in the deployed app.
