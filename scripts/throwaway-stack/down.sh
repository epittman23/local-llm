#!/usr/bin/env bash
# Stop the stub and every backend these scripts started (by pid file), then
# stop (not delete) the throwaway containers. Never touches local-llm-*.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

shopt -s nullglob
for f in "$LLLM_TW_STATE"/backend-*.pid; do
	tw_stop_pidfile "$f"
done
tw_stop_pidfile "$LLLM_TW_STATE/stub.pid"
rm -f "$LLLM_TW_STATE/stub.port"
for name in "$LLLM_TW_PG_NAME" "$LLLM_TW_REDIS_NAME"; do
	if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
		docker stop "$name" >/dev/null
	fi
done
echo "throwaway stack stopped"
