#!/usr/bin/env bash
# Start (create if missing) the throwaway Postgres (pgvector) and Redis
# containers and wait until both answer. Ports: LLLM_THROWAWAY_PG_PORT
# (default 55440) and LLLM_THROWAWAY_REDIS_PORT (default 56380).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tw_refuse_owner_port "$LLLM_TW_PG_PORT"
tw_refuse_owner_port "$LLLM_TW_REDIS_PORT"
mkdir -p "$LLLM_TW_STATE"

ensure() { # name, create command...
	local name=$1
	shift
	if tw_container_exists "$name"; then
		docker start "$name" >/dev/null
	else
		"$@" >/dev/null
	fi
}

ensure "$LLLM_TW_PG_NAME" docker run -d --name "$LLLM_TW_PG_NAME" \
	-p "127.0.0.1:$LLLM_TW_PG_PORT:5432" \
	-e POSTGRES_USER=local_llm -e "POSTGRES_PASSWORD=$LLLM_TW_PG_PASSWORD" -e POSTGRES_DB=local_llm \
	pgvector/pgvector:pg16
ensure "$LLLM_TW_REDIS_NAME" docker run -d --name "$LLLM_TW_REDIS_NAME" \
	-p "127.0.0.1:$LLLM_TW_REDIS_PORT:6379" redis:7.4.2-alpine

# Probe over TCP: the image's first-start init runs a temporary server on the
# Unix socket only, which a socket probe would take for the real one.
for _ in $(seq 1 60); do
	if docker exec "$LLLM_TW_PG_NAME" pg_isready -q -h 127.0.0.1 -p 5432 -U local_llm -d local_llm &&
		[ "$(docker exec "$LLLM_TW_REDIS_NAME" redis-cli ping 2>/dev/null)" = PONG ]; then
		echo "throwaway postgres :$LLLM_TW_PG_PORT and redis :$LLLM_TW_REDIS_PORT ready"
		exit 0
	fi
	sleep 1
done
echo "throwaway containers did not become ready" >&2
exit 1
