# local-llm entry points.
#
#   make backend    Postgres + the backend (uvicorn
#                    --reload, :4000); tears Postgres down on exit,
#                    including Ctrl-C.
#   make frontend   the Astro + React + shadcn/ui frontend (apps/web,
#                    astro dev, :5174), proxying API/WS calls to :4000.
#                    `make astro` is the same target under its old name.
#                    Not needed to use the app: `make backend` also serves
#                    the last `bun run build` of apps/web at :4000/.
#   make lint       pre-commit over every file (CI's "Lint and format").
#   make test       backend pytest + web checks + Playwright (CI's other jobs).
#   make check      lint, then test: one command that predicts `CI passed`.
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
# Keep in sync with PRE_COMMIT_VERSION in .github/workflows/ci.yml.
PRE_COMMIT_VERSION := 4.6.2
# Host port for the throwaway Postgres `make test-backend` starts; not 5432,
# so it never collides with `make backend`'s database.
LLLM_TEST_PG_PORT ?= 55432

.PHONY: help backend frontend astro lint test test-backend test-web test-e2e check

help:
	@echo "make backend   Postgres + the backend (uvicorn --reload, $(LLLM_BACKEND_HOST):$(LLLM_BACKEND_PORT))"
	@echo "make frontend  Astro + React + shadcn/ui dev server (astro dev, :5174; alias: make astro)"
	@echo "make lint      pre-commit over every file, as CI runs it"
	@echo "make test      test-backend + test-web + test-e2e, as CI runs them"
	@echo "make check     lint, then test (predicts CI's 'CI passed')"

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

# --- Checks: the same commands as .github/workflows/ci.yml, job for job, so a
# green `make check` predicts a green `CI passed`. If you change a CI job,
# change its target here too.

# CI's "Lint and format (pre-commit)". no-commit-to-branch is skipped for the
# same reason as in CI: it guards commits, not the tree.
lint:
	@cd "$(WEB_DIR)" && bun install --frozen-lockfile
	SKIP=no-commit-to-branch uvx pre-commit@$(PRE_COMMIT_VERSION) run --all-files --show-diff-on-failure

# CI's "Backend (pytest)", including the throwaway pgvector Postgres that
# tests/test_imports.py needs (without it that test skips locally, while CI
# fails). The container is removed on exit, Ctrl-C included. DATA_DIR is the
# suite's own temp directory (tests/conftest.py), as in CI.
test-backend:
	@cd "$(SERVER_DIR)"; \
	uv lock --check; \
	uv sync --frozen --no-install-project --group dev; \
	if ss -ltn | grep -q "127.0.0.1:$(LLLM_TEST_PG_PORT) "; then \
		echo "make test-backend: port $(LLLM_TEST_PG_PORT) is in use -- set LLLM_TEST_PG_PORT" >&2; \
		exit 1; \
	fi; \
	pg="lllm-test-pg-$$$$"; \
	trap 'docker rm -f "$$pg" >/dev/null 2>&1' EXIT; \
	docker run --rm -d --name "$$pg" -p "127.0.0.1:$(LLLM_TEST_PG_PORT):5432" \
		-e POSTGRES_USER=local_llm -e POSTGRES_PASSWORD=test-only-not-a-secret -e POSTGRES_DB=local_llm \
		pgvector/pgvector:pg16 >/dev/null; \
	for i in $$(seq 1 60); do \
		docker exec "$$pg" psql -U local_llm -d local_llm -tAc 'select 1' >/dev/null 2>&1 && break; \
		sleep 1; \
	done; \
	LLLM_SECRET_KEY=test-only-not-a-secret-0123456789abcdef0123456789abcdef \
	TEST_DATABASE_URL="postgresql://local_llm:test-only-not-a-secret@127.0.0.1:$(LLLM_TEST_PG_PORT)/local_llm" \
	uv run --frozen python -m pytest tests -q

# CI's "Web (astro check, vitest, build)".
test-web:
	@cd "$(WEB_DIR)" && \
	bun install --frozen-lockfile && \
	bunx astro check && \
	bun run test:unit && \
	bun run build

# CI's "Web e2e (Playwright, mocked backend)". Two workers, CI's count: at the
# default (half the cores) a cold dev server misses 5 s timeouts here. Stop
# `make frontend` first; Playwright reuses and then stops a running dev server.
test-e2e:
	@cd "$(WEB_DIR)" && \
	bun install --frozen-lockfile && \
	bunx playwright install chromium && \
	bunx playwright test --workers=2

test: test-backend test-web test-e2e

check: lint test

