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
#   make desktop    the desktop app (apps/desktop) from this checkout, which
#                    starts the stack above itself when nothing is running.
#   make lint       pre-commit over every file (CI's "Lint and format").
#   make secrets    gitleaks over the whole git history (CI's "Secrets").
#   make pr-gate PR=<n>  the PR gate's title, attribution and tripwire
#                    checks on pull request <n>, read-only.
#   make test       backend pytest + web checks + Playwright + desktop checks
#                    + the real-stack boot smoke (CI's other jobs).
#   make check      lint, secrets, then test: one command that predicts
#                    `CI passed`.
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
DESKTOP_DIR := $(REPO_ROOT)/apps/desktop
COMPOSE := docker compose -f $(REPO_ROOT)/infra/docker-compose.yml
LLLM_BACKEND_PORT ?= 4000
# Loopback by default: the backend's admin API can start processes on this
# machine, so it is not offered to the LAN unless asked for with
# `make backend LLLM_BACKEND_HOST=0.0.0.0` (docs/history/code-review.md L13).
LLLM_BACKEND_HOST ?= 127.0.0.1
# uvicorn's flags beyond host and port. `--timeout-graceful-shutdown 10` in
# place of the default gives a backend that doesn't reload and whose shutdown
# can't hang: without a timeout, uvicorn waits on every open request first,
# and a page streaming a log never finishes one. The desktop app runs it so.
LLLM_UVICORN_FLAGS ?= --reload
# Keep in sync with PRE_COMMIT_VERSION in .github/workflows/ci.yml.
PRE_COMMIT_VERSION := 4.6.2
# Keep in sync with DIFF_COVER_VERSION and DIFF_COVER_FAIL_UNDER in
# .github/workflows/ci.yml. DIFF_BASE is what the changed lines are measured
# against: CI uses the pull request's base commit.
DIFF_COVER_VERSION := 10.6.0
DIFF_COVER_FAIL_UNDER := 80
DIFF_BASE ?= origin/main
# Keep in sync with GITLEAKS_IMAGE in .github/workflows/ci.yml.
GITLEAKS_IMAGE := zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
# Host port for the throwaway Postgres `make test-backend` starts; not 5432,
# so it never collides with `make backend`'s database.
LLLM_TEST_PG_PORT ?= 55432
# Host ports for `make test-boot`'s throwaway Postgres and Redis.
LLLM_BOOT_PG_PORT ?= 55433
LLLM_BOOT_REDIS_PORT ?= 56379

.PHONY: help backend frontend astro desktop lint secrets pr-gate test test-backend test-boot test-web test-e2e test-desktop check

help:
	@echo "make backend   Postgres + Redis + the backend (uvicorn --reload, $(LLLM_BACKEND_HOST):$(LLLM_BACKEND_PORT))"
	@echo "make frontend  Astro + React + shadcn/ui dev server (astro dev, :5174; alias: make astro)"
	@echo "make desktop   the desktop app from this checkout (it starts and stops the stack itself)"
	@echo "make lint      pre-commit over every file, as CI runs it"
	@echo "make secrets   gitleaks over the whole git history"
	@echo "make pr-gate PR=<n>  the PR gate's checks on pull request <n> (read-only)"
	@echo "make test      test-backend + test-web + test-e2e + test-desktop + test-boot, as CI runs them"
	@echo "make check     lint, secrets, then test (predicts CI's 'CI passed')"

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
# doesn't use are behind `--extra all` (see pyproject.toml). The sync is
# pinned to apps/server/.venv, the interpreter run below, so a
# UV_PROJECT_ENVIRONMENT exported for another project can't redirect it.
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
	trap 'echo "==> Stopping Postgres and Redis"; $(COMPOSE) down' EXIT; \
	echo "==> Starting Postgres and Redis"; \
	$(COMPOSE) up -d postgres redis; \
	if ! command -v uv >/dev/null 2>&1; then \
		echo "make backend: uv not found -- install it (https://docs.astral.sh/uv/, e.g. \`curl -LsSf https://astral.sh/uv/install.sh | sh\`)" >&2; \
		exit 1; \
	fi; \
	echo "==> Syncing the backend environment"; \
	UV_PROJECT_ENVIRONMENT="$(SERVER_DIR)/.venv" uv sync --frozen --no-install-project --project "$(SERVER_DIR)"; \
	py="$(SERVER_DIR)/.venv/bin/python"; \
	database_url="$$(PYTHONPATH="$(SERVER_DIR)" "$$py" -c 'import sys; from local_llm.benchmarks.serving.launcher import build_database_url; print(build_database_url(sys.argv[1]))' "$$POSTGRES_PASSWORD")"; \
	echo "==> Starting the backend on $(LLLM_BACKEND_HOST):$(LLLM_BACKEND_PORT)"; \
	cd "$(SERVER_DIR)" && \
	CORS_ALLOW_ORIGIN="http://localhost:$(LLLM_BACKEND_PORT);http://127.0.0.1:$(LLLM_BACKEND_PORT);http://localhost:5174;http://127.0.0.1:5174" \
	LLLM_SECRET_KEY="$$LLLM_SECRET_KEY" \
	DATABASE_URL="$$database_url" \
	REDIS_URL="redis://127.0.0.1:6379/0" \
	DATA_DIR="$(DATA_DIR)" \
	VECTOR_DB=pgvector \
	OPENAI_API_BASE_URL="https://openrouter.ai/api/v1" \
	OPENAI_API_KEY="$$OPENROUTER_API_KEY" \
	HF_HUB_OFFLINE=1 \
	"$$py" -m uvicorn local_llm.main:app --host $(LLLM_BACKEND_HOST) --port $(LLLM_BACKEND_PORT) $(LLLM_UVICORN_FLAGS)

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

# The desktop app (apps/desktop) from this checkout, for working on it; the
# installed app is `cd apps/desktop && bun run package` (docs/guides/desktop.md).
# It starts `make backend` itself when nothing answers on :4000, and stops it
# when it closes. Ctrl-C here closes it the same way, once: Electron (Chromium)
# takes a first SIGINT as "quit" and dies of a second, leaving the stack
# running for the next launch to adopt. So the binary is exec'd directly
# rather than through electron's cli.js, which would forward a second copy of
# the terminal's SIGINT. `require('electron')` is its path (downloaded on first
# use); ELECTRON_RUN_AS_NODE, which VS Code's terminal can export, is unset.
desktop:
	@cd "$(DESKTOP_DIR)" && \
	bun install --frozen-lockfile && \
	bun run build && \
	electron="$$(node -p "require('electron')")" && \
	exec env -u ELECTRON_RUN_AS_NODE "$$electron" .

# --- Checks: the same commands as .github/workflows/ci.yml, job for job, so a
# green `make check` predicts a green `CI passed`. If you change a CI job,
# change its target here too.

# CI's "Lint and format (pre-commit)". no-commit-to-branch and gitleaks are
# skipped for the same reasons as in CI: the first guards commits, not the
# tree, and the second only sees staged changes (`make secrets` scans commits).
lint:
	@cd "$(WEB_DIR)" && bun install --frozen-lockfile
	@cd "$(DESKTOP_DIR)" && bun install --frozen-lockfile
	SKIP=no-commit-to-branch,gitleaks uvx pre-commit@$(PRE_COMMIT_VERSION) run --all-files --show-diff-on-failure

# CI's "Secrets (gitleaks)". CI scans a pull request's own commits and main's
# whole history; this scans the whole history, a superset of either, in
# about 20 s. Known non-secrets are in .gitleaksignore.
secrets:
	docker run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) git --no-banner --redact --verbose /repo

# The PR gate workflow (.github/workflows/pr-gate.yml) on one pull request,
# read-only: it never removes a label. It reads the PR through the API, so it
# checks what is pushed, not the working tree. Its unit tests run in
# `make lint`. See AGENTS.md, "The CI tripwire".
pr-gate:
	@[ -n "$(PR)" ] || { echo "make pr-gate: set PR=<number>" >&2; exit 1; }
	python3 .github/scripts/pr_gate.py --pr $(PR)

# CI's "Backend (pytest)", including the throwaway pgvector Postgres that
# tests/test_imports.py needs (without it that test skips locally, while CI
# fails). The container is removed on exit, Ctrl-C included. DATA_DIR is the
# suite's own temp directory (tests/conftest.py), as in CI.
# The venv is pinned as in `backend`: `uv sync` removes what the lock doesn't
# list, so following an inherited UV_PROJECT_ENVIRONMENT would strip another
# project's environment.
test-backend:
	@cd "$(SERVER_DIR)"; \
	export UV_PROJECT_ENVIRONMENT="$(SERVER_DIR)/.venv"; \
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
	uv run --frozen python -m pytest tests -q --cov --cov-report=xml; \
	uvx "diff-cover@$(DIFF_COVER_VERSION)" coverage.xml \
		--compare-branch="$(DIFF_BASE)" --fail-under="$(DIFF_COVER_FAIL_UNDER)"

# CI's "Boot (real stack)": the backend started as `make backend` starts it,
# against a throwaway Postgres and Redis (infra/docker-compose.yml's images)
# and a stub in place of OpenRouter, then used; tests/boot_smoke.py has the
# checks. Builds apps/web first, since the backend serves it. The containers
# are removed on exit, Ctrl-C included, and nothing touches `make backend`'s
# database.
test-boot:
	@cd "$(WEB_DIR)" && bun install --frozen-lockfile && bun run build
	@cd "$(SERVER_DIR)"; \
	export UV_PROJECT_ENVIRONMENT="$(SERVER_DIR)/.venv"; \
	uv sync --frozen --no-install-project; \
	for port in $(LLLM_BOOT_PG_PORT) $(LLLM_BOOT_REDIS_PORT); do \
		if ss -ltn | grep -q "127.0.0.1:$$port "; then \
			echo "make test-boot: port $$port is in use -- set LLLM_BOOT_PG_PORT / LLLM_BOOT_REDIS_PORT" >&2; \
			exit 1; \
		fi; \
	done; \
	pg="lllm-boot-pg-$$$$"; redis="lllm-boot-redis-$$$$"; \
	trap 'docker rm -f "$$pg" "$$redis" >/dev/null 2>&1' EXIT; \
	docker run --rm -d --name "$$pg" -p "127.0.0.1:$(LLLM_BOOT_PG_PORT):5432" \
		-e POSTGRES_USER=local_llm -e POSTGRES_PASSWORD=test-only-not-a-secret -e POSTGRES_DB=local_llm \
		pgvector/pgvector:pg16 >/dev/null; \
	docker run --rm -d --name "$$redis" -p "127.0.0.1:$(LLLM_BOOT_REDIS_PORT):6379" redis:7.4.2-alpine >/dev/null; \
	for i in $$(seq 1 60); do \
		docker exec "$$pg" psql -U local_llm -d local_llm -tAc 'select 1' >/dev/null 2>&1 && break; \
		sleep 1; \
	done; \
	LLLM_SECRET_KEY=test-only-not-a-secret-0123456789abcdef0123456789abcdef \
	DATABASE_URL="postgresql://local_llm:test-only-not-a-secret@127.0.0.1:$(LLLM_BOOT_PG_PORT)/local_llm" \
	REDIS_URL="redis://127.0.0.1:$(LLLM_BOOT_REDIS_PORT)/0" \
	uv run --frozen python tests/boot_smoke.py

# CI's "Web (astro check, vitest, build)", with the same coverage of the
# changed lines as CI (against DIFF_BASE).
test-web:
	@cd "$(WEB_DIR)" && \
	bun install --frozen-lockfile && \
	bunx astro check && \
	bun run test:coverage && \
	sed 's#^SF:#SF:apps/web/#' coverage/lcov.info > coverage/lcov-repo.info && \
	(cd "$(REPO_ROOT)" && uvx "diff-cover@$(DIFF_COVER_VERSION)" apps/web/coverage/lcov-repo.info \
		--compare-branch="$(DIFF_BASE)" --fail-under="$(DIFF_COVER_FAIL_UNDER)") && \
	bun run build

# CI's "Web e2e (Playwright, mocked backend)". Two workers, CI's count: at the
# default (half the cores) a cold dev server misses 5 s timeouts here. Stop
# `make frontend` first; Playwright reuses and then stops a running dev server.
test-e2e:
	@cd "$(WEB_DIR)" && \
	bun install --frozen-lockfile && \
	bunx playwright install chromium && \
	bunx playwright test --workers=2

# CI's "Desktop (typecheck, vitest, package smoke)". The unpacked package
# catches an electron-builder bump that breaks packaging, which Dependabot
# would otherwise merge on green.
test-desktop:
	@cd "$(DESKTOP_DIR)" && \
	bun install --frozen-lockfile && \
	bun run typecheck && \
	bun run test:unit && \
	bun run package:dir

test: test-backend test-web test-e2e test-desktop test-boot

check: lint secrets test

