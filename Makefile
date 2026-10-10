# local-llm entry points.
#
#   make backend    Postgres + the Open WebUI fork's backend (uvicorn
#                    --reload, :4000); tears Postgres down on exit,
#                    including Ctrl-C.
#   make frontend   the Astro + React + shadcn/ui frontend (apps/web,
#                    astro dev, :5174), proxying API/WS calls to :4000.
#                    `make astro` is the same target under its old name.
#                    Not needed to use the app: `make backend` also serves
#                    the last `bun run build` of apps/web at :4000/.
#   make help       this text.
#
# Replaces scripts/shell/main.sh's lllm-backend/lllm-frontend, deleted along
# with the rest of scripts/ in Phase 2c of docs/history/migration-plan.md -- see that
# file and docs/decisions.md for why. Serving configuration
# itself (profiles, argv assembly, fingerprinting) moved into the backend as
# Python in Phases 2a/2b; this Makefile only owns process lifecycle, the same
# job lllm-backend/lllm-frontend had.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SERVER_DIR := $(REPO_ROOT)/apps/server
# DATA_DIR is pinned rather than left to env.py's default (the package's
# parent directory): that default moved once already, when apps/server/backend/
# was flattened into apps/server/, and a moved default silently starts the
# backend on an empty uploads/cache/benchmark-datasets directory. Same
# reasoning as the pinned Compose project name in infra/docker-compose.yml.
DATA_DIR ?= $(REPO_ROOT)/apps/server/data
WEB_DIR := $(REPO_ROOT)/apps/web
COMPOSE := docker compose -f $(REPO_ROOT)/infra/docker-compose.yml
LLLM_BACKEND_PORT ?= 4000
# Loopback by default: the backend's admin API can start processes on this
# machine, so it is not offered to the LAN unless asked for with
# `make backend LLLM_BACKEND_HOST=0.0.0.0` (docs/history/code-review.md L13).
LLLM_BACKEND_HOST ?= 127.0.0.1

.PHONY: help backend frontend astro

help:
	@echo "make backend   Postgres + Open WebUI fork backend (uvicorn --reload, $(LLLM_BACKEND_HOST):$(LLLM_BACKEND_PORT))"
	@echo "make frontend  Astro + React + shadcn/ui dev server (astro dev, :5174; alias: make astro)"

# --reload caveat: a code change restarts the uvicorn worker, and with it the
# in-memory handle Benchmarks > Serve keeps on a running llama-server. The
# server itself runs in its own session and survives, so after a reload the
# Serve page reads "Stopped" while the model still holds VRAM; stop it with
# `pkill -f llama-server` before starting another. Avoid editing backend code
# while a benchmark server is up.
#
# One shell invocation for the whole recipe (line continuations, not separate
# make lines) so the EXIT trap covers the real work below it, Ctrl-C
# included. uvicorn is never exec'd for the same reason: exec would replace
# this shell -- and its trap -- with uvicorn's process image.
#
# The venv is apps/server/pyproject.toml + uv.lock, applied exactly by
# `uv sync --frozen` on every run: a no-op when nothing changed, and it
# removes anything the lock no longer lists. uv also fetches a matching
# Python (3.12) if the machine has none. Optional backends the install
# doesn't use are behind `--extra all` (see pyproject.toml).
backend:
	@envfile="$(REPO_ROOT)/infra/.env"; \
	if [ ! -f "$$envfile" ]; then \
		echo "make backend: $$envfile not found -- copy infra/.env.example and fill in OPENROUTER_API_KEY, POSTGRES_PASSWORD, LLLM_SECRET_KEY" >&2; \
		exit 1; \
	fi; \
	set -a; source "$$envfile"; set +a; \
	missing=""; \
	for key in OPENROUTER_API_KEY POSTGRES_PASSWORD LLLM_SECRET_KEY; do \
		if [ -z "$${!key:-}" ]; then missing="$$missing $$key"; fi; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "make backend: infra/.env is missing:$$missing (WEBUI_SECRET_KEY was renamed LLLM_SECRET_KEY on 2026-10-10)" >&2; \
		exit 1; \
	fi; \
	trap '$(COMPOSE) down' EXIT; \
	$(COMPOSE) up -d postgres; \
	if ! command -v uv >/dev/null 2>&1; then \
		echo "make backend: uv not found -- install it (https://docs.astral.sh/uv/, e.g. \`curl -LsSf https://astral.sh/uv/install.sh | sh\`)" >&2; \
		exit 1; \
	fi; \
	uv sync --frozen --no-install-project --project "$(SERVER_DIR)"; \
	py="$(SERVER_DIR)/.venv/bin/python"; \
	database_url="$$(PYTHONPATH="$(SERVER_DIR)" "$$py" -c 'import sys; from local_llm.benchmarks.serving.launcher import build_database_url; print(build_database_url(sys.argv[1]))' "$$POSTGRES_PASSWORD")"; \
	cd "$(SERVER_DIR)" && \
	CORS_ALLOW_ORIGIN="http://localhost:$(LLLM_BACKEND_PORT);http://127.0.0.1:$(LLLM_BACKEND_PORT);http://localhost:5174;http://127.0.0.1:5174" \
	LLLM_SECRET_KEY="$$LLLM_SECRET_KEY" \
	DATABASE_URL="$$database_url" \
	DATA_DIR="$(DATA_DIR)" \
	VECTOR_DB=pgvector \
	OPENAI_API_BASE_URL="https://openrouter.ai/api/v1" \
	OPENAI_API_KEY="$$OPENROUTER_API_KEY" \
	HF_HUB_OFFLINE=1 \
	"$$py" -m uvicorn local_llm.main:app --host $(LLLM_BACKEND_HOST) --port $(LLLM_BACKEND_PORT) --reload

# astro dev always daemonizes (this Astro version's own CLI design, not a
# choice made here): even a plain `astro dev` reports its dev server as
# "background" and the wrapping process exits once it is up, leaving the
# real server as an orphan with nothing left in the foreground for Ctrl-C to
# reach. So this recipe starts it explicitly backgrounded, blocks on
# `astro dev logs --follow` instead (a real foreground process Ctrl-C can
# hit), and the trap runs `astro dev stop` on exit either way.
frontend:
	@cd "$(WEB_DIR)" && \
	bun install --frozen-lockfile && \
	trap 'bunx astro dev stop' EXIT; \
	LLLM_BACKEND_URL="http://localhost:$(LLLM_BACKEND_PORT)" bunx astro dev --background; \
	bunx astro dev logs --follow

# The target's name through the migration, when `frontend` was the Svelte app.
astro: frontend
