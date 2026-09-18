# local-llm entry points.
#
#   make backend    Postgres + the Open WebUI fork's backend (uvicorn
#                    --reload, :4000); tears Postgres down on exit,
#                    including Ctrl-C.
#   make frontend   the Open WebUI fork's frontend (vite dev, :5173),
#                    proxying API/WS calls to :4000.
#   make help       this text.
#
# Replaces scripts/shell/main.sh's lllm-backend/lllm-frontend, deleted along
# with the rest of scripts/ in Phase 2c of docs/migration-plan.md -- see that
# file and docs/CLAUDE.md's decisions log for why. Serving configuration
# itself (profiles, argv assembly, fingerprinting) moved into the backend as
# Python in Phases 2a/2b; this Makefile only owns process lifecycle, the same
# job lllm-backend/lllm-frontend had.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BACKEND_DIR := $(REPO_ROOT)/apps/openwebui/backend
FRONTEND_DIR := $(REPO_ROOT)/apps/openwebui
COMPOSE := docker compose -f $(REPO_ROOT)/infra/docker-compose.yml
LLLM_BACKEND_PORT ?= 4000

.PHONY: help backend frontend

help:
	@echo "make backend   Postgres + Open WebUI fork backend (uvicorn --reload, :$(LLLM_BACKEND_PORT))"
	@echo "make frontend  Open WebUI fork frontend (vite dev, :5173)"

# One shell invocation for the whole recipe (line continuations, not separate
# make lines) so the EXIT trap covers the real work below it, Ctrl-C
# included. uvicorn is never exec'd for the same reason: exec would replace
# this shell -- and its trap -- with uvicorn's process image.
backend:
	@envfile="$(REPO_ROOT)/infra/.env"; \
	if [ ! -f "$$envfile" ]; then \
		echo "make backend: $$envfile not found -- create it with OPENROUTER_API_KEY, POSTGRES_PASSWORD, WEBUI_SECRET_KEY" >&2; \
		exit 1; \
	fi; \
	set -a; source "$$envfile"; set +a; \
	trap '$(COMPOSE) down' EXIT; \
	$(COMPOSE) up -d postgres; \
	venv_dir="$(BACKEND_DIR)/.venv"; \
	venv="$$venv_dir/bin/python"; \
	stamp="$$venv_dir/.lllm-bootstrap-complete"; \
	in_range='import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] < (3, 13) else 1)'; \
	py=""; \
	if [ -x "$$venv" ] && [ -f "$$stamp" ]; then \
		py="$$venv"; \
	elif [ -x "$$venv" ]; then \
		if "$$venv" -c "$$in_range" 2>/dev/null \
		   && "$$venv" -c 'import uvicorn, alembic, sqlalchemy, fastapi' 2>/dev/null; then \
			: > "$$stamp"; py="$$venv"; \
		else \
			echo "make backend: $$venv_dir is incomplete or on an unsupported Python; rebuilding it" >&2; \
			rm -rf "$$venv_dir"; \
		fi; \
	fi; \
	if [ -z "$$py" ]; then \
		base=""; \
		for candidate in $${LLAMA_OPENWEBUI_PYTHON:-python3.12 python3.11 python3}; do \
			found="$$(command -v "$$candidate" 2>/dev/null)" || continue; \
			if "$$found" -c "$$in_range" 2>/dev/null; then base="$$found"; break; fi; \
		done; \
		if [ -z "$$base" ]; then \
			echo "make backend: no Python in the fork's supported range (>= 3.11, < 3.13) found; tried: $${LLAMA_OPENWEBUI_PYTHON:-python3.12 python3.11 python3}. Install python3.12, or point LLAMA_OPENWEBUI_PYTHON at a 3.11/3.12 interpreter." >&2; \
			exit 1; \
		fi; \
		echo "make backend: creating $$venv_dir with $$base ($$("$$base" --version 2>&1)); first run installs the fork's backend requirements, several GB" >&2; \
		if "$$base" -m venv "$$venv_dir" \
		   && "$$venv" -m pip install -q --upgrade pip \
		   && "$$venv" -m pip install -q -r "$(BACKEND_DIR)/requirements.txt"; then \
			: > "$$stamp"; py="$$venv"; \
		else \
			echo "make backend: installing the fork's backend requirements failed; removed the partial $$venv_dir so the next run retries from scratch" >&2; \
			rm -rf "$$venv_dir"; \
			exit 1; \
		fi; \
	fi; \
	database_url="$$(PYTHONPATH="$(BACKEND_DIR)" "$$py" -c 'import sys; from open_webui.benchmarks.serving.launcher import build_database_url; print(build_database_url(sys.argv[1]))' "$$POSTGRES_PASSWORD")"; \
	cd "$(BACKEND_DIR)" && \
	CORS_ALLOW_ORIGIN="http://localhost:5173" \
	WEBUI_SECRET_KEY="$$WEBUI_SECRET_KEY" \
	DATABASE_URL="$$database_url" \
	VECTOR_DB=pgvector \
	OPENAI_API_BASE_URL="https://openrouter.ai/api/v1" \
	OPENAI_API_KEY="$$OPENROUTER_API_KEY" \
	HF_HUB_OFFLINE=1 \
	"$$py" -m uvicorn open_webui.main:app --host 0.0.0.0 --port $(LLLM_BACKEND_PORT) --reload

frontend:
	@cd "$(FRONTEND_DIR)" && \
	if [ ! -d node_modules ]; then CYPRESS_INSTALL_BINARY=0 bun install; fi && \
	WEBUI_BACKEND_URL="http://localhost:$(LLLM_BACKEND_PORT)" bun run dev
