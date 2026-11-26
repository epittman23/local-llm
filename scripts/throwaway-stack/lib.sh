# Shared settings for the throwaway stack scripts (sourced, not run).
# Everything lives on high ports and under one state directory, never the
# owner's :4000, :5432, :6379, apps/server/data or local-llm-* containers.

LLLM_TW_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/local-llm-throwaway"
LLLM_TW_PG_PORT="${LLLM_THROWAWAY_PG_PORT:-55440}"
LLLM_TW_REDIS_PORT="${LLLM_THROWAWAY_REDIS_PORT:-56380}"
LLLM_TW_PG_NAME=lllm-throwaway-pg
LLLM_TW_REDIS_NAME=lllm-throwaway-redis
LLLM_TW_PG_PASSWORD=test-only-not-a-secret
LLLM_TW_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Stop the process in a pid file (SIGTERM, then wait up to 30 s) and remove it.
tw_stop_pidfile() {
	local file=$1 pid i
	[ -f "$file" ] || return 0
	pid=$(cat "$file")
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		for i in $(seq 1 30); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 1
		done
	fi
	rm -f "$file"
}
