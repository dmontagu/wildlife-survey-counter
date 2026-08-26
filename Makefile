# if prek is installed use prek otherwise use pre-commit
PRE_COMMIT_CMD = $(if $(shell command -v prek 2> /dev/null),prek,pre-commit)

# Derive compose project name: "wsc" in main repo, "wsc-<dirname>" in worktrees
_GIT_DIR := $(shell git rev-parse --git-dir 2>/dev/null)
_IS_WORKTREE := $(findstring /worktrees/,$(_GIT_DIR))
_WORKTREE_SUFFIX := $(if $(_IS_WORKTREE),-$(shell basename "$$(git rev-parse --show-toplevel)"))
export COMPOSE_PROJECT_NAME ?= wsc$(_WORKTREE_SUFFIX)

.PHONY: install
install:
	@echo "Installing development dependencies"
	uv sync
	cd src/frontend && npm install
	@if ! command -v prek > /dev/null 2>&1 && ! command -v pre-commit > /dev/null 2>&1; then \
		echo "Installing prek (pre-commit hook runner)..."; \
		brew install prek 2>/dev/null || echo "Warning: could not install prek. Install manually: brew install prek"; \
	fi
	$(PRE_COMMIT_CMD) install

.PHONY: dev
dev:
	@trap 'kill 0' EXIT; \
	uv run python -m wildlife_counter.server & \
	cd src/frontend && npm run dev & \
	wait

.PHONY: build
build:
	@echo "Building frontend for production"
	cd src/frontend && npm run build

.PHONY: serve
serve: build
	@echo "Serving production build"
	uv run python -m wildlife_counter.server

.PHONY: format-py
format-py:
	@echo "Run ruff check and ruff format"
	uv run ruff check --fix src/wildlife_counter/
	uv run ruff format src/wildlife_counter/

.PHONY: format-ts
format-ts:
	@echo "Run biome format"
	npx --prefix src/frontend biome check --write src/frontend/

.PHONY: format
format: format-py format-ts

.PHONY: lint-py
lint-py:
	@echo "Run ruff check"
	uv run ruff check src/wildlife_counter/

.PHONY: lint-ts
lint-ts:
	@echo "Run biome lint"
	npx --prefix src/frontend biome lint src/frontend/

.PHONY: check-ts
check-ts:
	@echo "Run biome check (format + lint + imports, same as CI)"
	npx --prefix src/frontend biome check src/frontend/

.PHONY: lint
lint: lint-py check-ts

.PHONY: typecheck-py
typecheck-py:
	@echo "Run pyright"
	uv run pyright

.PHONY: typecheck-ts
typecheck-ts:
	@echo "Run typescript typecheck"
	cd src/frontend && npx tsc --noEmit

.PHONY: typecheck
typecheck: typecheck-py typecheck-ts

.PHONY: clean
clean:
	rm -rf src/frontend/dist src/frontend/node_modules/.vite

# --- Production Docker ---

# Set WITH_ML=true to also install the [ml] extra (torch, transformers,
# ultralytics) and pre-download model weights for the agent sandbox.
WITH_ML ?= false

.PHONY: docker-build
docker-build:
	@if [ "$(WITH_ML)" != "true" ] && [ "$(WITH_ML)" != "false" ]; then \
		echo "WITH_ML must be 'true' or 'false' (got '$(WITH_ML)')"; exit 1; fi
	@echo "Building Docker image (WITH_ML=$(WITH_ML))"
	docker build --build-arg WITH_ML=$(WITH_ML) -t wildlife-survey-counter .

.PHONY: docker-run
docker-run: docker-build
	docker run --rm -p 8100:8100 wildlife-survey-counter

# --- .env (auto-generated, read by docker compose and dc alias) ---

.PHONY: env
env:
	@if [ -f .env ] && grep -q '^COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME)$$' .env; then \
		true; \
	elif [ -f .env ] && grep -q '^COMPOSE_PROJECT_NAME=' .env; then \
		sed -i '' 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME)/' .env; \
		echo "Updated COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) in .env"; \
	else \
		echo "COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME)" >> .env; \
		echo "Written COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) to .env"; \
	fi

# --- Traefik (shared reverse proxy, runs across all projects) ---

.PHONY: traefik-up
traefik-up:
	@docker network inspect traefik >/dev/null 2>&1 || docker network create traefik
	@if docker inspect traefik-proxy >/dev/null 2>&1; then \
		echo "Traefik already running — dashboard at http://localhost:8080"; \
	else \
		docker compose -f docker/traefik.yml up -d && \
		echo "Traefik started — dashboard at http://localhost:8080"; \
	fi

.PHONY: traefik-down
traefik-down:
	docker compose -f docker/traefik.yml down -v --remove-orphans

.PHONY: traefik-logs
traefik-logs:
	docker logs -f traefik-proxy

# --- Stack (project-specific services) ---

.PHONY: up
up: env traefik-up
	docker compose up -d --build --wait
	@echo ""
	@echo "Stack running:"
	@echo "  Frontend: http://$(COMPOSE_PROJECT_NAME).localhost"
	@echo "  Backend:  http://api.$(COMPOSE_PROJECT_NAME).localhost"

.PHONY: down
down:
	docker compose down

.PHONY: logs
logs:
	docker compose logs -f

.PHONY: logs-backend
logs-backend:
	docker compose logs -f backend

.PHONY: logs-frontend
logs-frontend:
	docker compose logs -f frontend

.PHONY: status
status:
	@echo "Stack: $(COMPOSE_PROJECT_NAME)"
	@echo "  Frontend: http://$(COMPOSE_PROJECT_NAME).localhost"
	@echo "  Backend:  http://api.$(COMPOSE_PROJECT_NAME).localhost"
	@echo "  Traefik:  http://localhost:8080"
	@echo ""
	@docker compose ps 2>/dev/null || echo "  (not running)"
