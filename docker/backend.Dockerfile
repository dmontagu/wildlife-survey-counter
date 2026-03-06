FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --no-install-project

# src/wildlife_counter is volume-mounted at runtime; copy for initial layer
COPY src/wildlife_counter/ src/wildlife_counter/

# Make the package importable without installing it (source is volume-mounted for dev)
ENV PYTHONPATH=/app/src

# Create storage dirs
RUN mkdir -p storage/samples storage/uploads

EXPOSE 8100

# --no-sync: deps are already installed at build time, skip re-syncing
# (uv run without this flag tries to install the project, which fails without README.md)
CMD ["uv", "run", "--no-sync", "python", "-m", "wildlife_counter.server"]
