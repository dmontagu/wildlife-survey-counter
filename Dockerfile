# Stage 1: Build frontend
FROM node:22-slim AS frontend-builder

WORKDIR /app/frontend
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm install

COPY src/frontend/ ./
RUN npm run build

# Stage 2: Python runtime (fat image with ML deps for agent sandbox)
FROM python:3.13-slim

# Install system deps for OpenCV (full, not headless — needed for sandbox scripts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgl1-mesa-glx \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install Python dependencies (base + ML extras for sandbox code execution)
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --no-install-project --extra ml

# Pre-download model weights (cached in Docker layer)
RUN uv run python -c "from ultralytics import YOLO; YOLO('yolov8x.pt')"
RUN uv run python -c "from transformers import Owlv2Processor, Owlv2ForObjectDetection; \
    Owlv2Processor.from_pretrained('google/owlv2-base-patch16-ensemble'); \
    Owlv2ForObjectDetection.from_pretrained('google/owlv2-base-patch16-ensemble')"

# Copy application code
COPY src/wildlife_counter/ src/wildlife_counter/

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist src/frontend/dist

# Create directories
RUN mkdir -p storage/samples storage/uploads storage/sandbox

# Copy sample data if present (optional, for demo)
COPY storage/sample[s]/ storage/samples/

EXPOSE 8100

CMD ["uv", "run", "python", "-m", "wildlife_counter.server", "--port", "8100"]
