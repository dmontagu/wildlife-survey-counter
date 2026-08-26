# Production image for the Wildlife Survey Counter.
#
# By default this builds the lean, headless app: FastAPI + blob detection +
# the built frontend, with no PyTorch and no model weights.
#
#   docker build -t wildlife-survey-counter .
#
# Pass WITH_ML=true to additionally install the `[ml]` extra (torch,
# transformers, ultralytics, ...) and pre-download the model weights the
# optional agent sandbox (`POST /api/agent-detect`) executes against. That
# image is several GB.
#
#   docker build --build-arg WITH_ML=true -t wildlife-survey-counter:ml .
#
# Declared before the first FROM so it can select the runtime stage below.
ARG WITH_ML=false

# ---------------------------------------------------------------------------
# Stage 1: build the frontend
# ---------------------------------------------------------------------------
FROM node:22-slim AS frontend-builder

WORKDIR /app/frontend
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm install

COPY src/frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Python dependencies (base — no ML)
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS deps-base

# opencv-python-headless only needs glib; no GL/X11 libraries required.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock* ./
RUN uv sync --locked --no-dev --no-install-project

# ---------------------------------------------------------------------------
# Stage 3a: WITH_ML=false — nothing extra to do
# ---------------------------------------------------------------------------
FROM deps-base AS deps-false

# ---------------------------------------------------------------------------
# Stage 3b: WITH_ML=true — system libs, ML extra, pre-downloaded weights
# ---------------------------------------------------------------------------
# Split out so `docker build --build-arg WITH_ML=true --target ml-system-libs .`
# can check the apt packages resolve without pulling multiple GB of wheels.
FROM deps-base AS ml-system-libs

# The `[ml]` extra pulls in full opencv-python, which links against libGL/X11.
# (libgl1-mesa-glx no longer exists on Debian 13 — the package is now libgl1.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

FROM ml-system-libs AS deps-true

RUN uv sync --locked --no-dev --no-install-project --extra ml

# Pre-download model weights so the sandbox does not fetch them at request time.
# --no-sync: dependencies are already installed; without it uv would try to
# build and install the project itself, which needs files not in this image.
RUN uv run --no-sync python -c "from ultralytics import YOLO; YOLO('yolov8x.pt')"
RUN uv run --no-sync python -c "from transformers import Owlv2Processor, Owlv2ForObjectDetection; \
    Owlv2Processor.from_pretrained('google/owlv2-base-patch16-ensemble'); \
    Owlv2ForObjectDetection.from_pretrained('google/owlv2-base-patch16-ensemble')"

# ---------------------------------------------------------------------------
# Stage 4: runtime — resolves to deps-false or deps-true
# ---------------------------------------------------------------------------
FROM deps-${WITH_ML} AS runtime

WORKDIR /app

# The project is not pip-installed (--no-install-project), so make the package
# importable from source instead.
ENV PYTHONPATH=/app/src

COPY src/wildlife_counter/ src/wildlife_counter/

COPY --from=frontend-builder /app/frontend/dist src/frontend/dist

RUN mkdir -p storage/samples storage/uploads storage/sandbox

EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8100/api/health')"]

CMD ["uv", "run", "--no-sync", "python", "-m", "wildlife_counter.server", "--port", "8100"]
