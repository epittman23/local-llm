#!/usr/bin/env bash
# Start a throwaway backend (no --reload) against the throwaway containers.
# Usage: backend.sh PORT [DIST] [DATA] [SERVER_DIR]
#   DIST        frontend build (default: apps/web/dist of this checkout)
#   DATA        data directory (default: <state dir>/data-PORT)
#   SERVER_DIR  an apps/server to run (a worktree's, for backend changes)
# Log and pid: <state dir>/backend-PORT.log and .pid. The model is the stub
# (stub.sh) on the port it recorded, or 4190.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PORT=${1:?usage: backend.sh PORT [DIST] [DATA] [SERVER_DIR]}
DIST=${2:-$LLLM_TW_REPO/apps/web/dist}
DATA=${3:-$LLLM_TW_STATE/data-$PORT}
SERVER=${4:-$LLLM_TW_REPO/apps/server}

tw_refuse_owner_port "$PORT"
tw_refuse_owner_port "$LLLM_TW_PG_PORT"
tw_refuse_owner_port "$LLLM_TW_REDIS_PORT"
real=$(realpath -m "$LLLM_TW_REPO/apps/server/data")
data_abs=$(realpath -m "$DATA")
case "$data_abs/" in
"$real"/*)
	echo "refusing DATA $DATA: it is or is inside the real DATA_DIR" >&2
	exit 1
	;;
esac
case "$real/" in
"${data_abs%/}"/*)
	echo "refusing DATA $DATA: it contains the real DATA_DIR" >&2
	exit 1
	;;
esac
mkdir -p "$LLLM_TW_STATE" "$DATA"

tw_stop_pidfile "$LLLM_TW_STATE/backend-$PORT.pid"
if [ -n "$(ss -ltnH "sport = :$PORT")" ]; then
	echo "port $PORT is in use by something this script did not start" >&2
	exit 1
fi

stub_port=4190
[ -f "$LLLM_TW_STATE/stub.port" ] && stub_port=$(cat "$LLLM_TW_STATE/stub.port")

cd "$SERVER"
LLLM_STOP_JOBS_ON_SHUTDOWN=true \
	LLLM_SECRET_KEY=test-only-not-a-secret-0123456789abcdef0123456789abcdef \
	DATABASE_URL="postgresql://local_llm:$LLLM_TW_PG_PASSWORD@127.0.0.1:$LLLM_TW_PG_PORT/local_llm" \
	REDIS_URL="redis://127.0.0.1:$LLLM_TW_REDIS_PORT/0" \
	DATA_DIR="$DATA" FRONTEND_BUILD_DIR="$DIST" VECTOR_DB=pgvector \
	OPENAI_API_BASE_URL="http://127.0.0.1:$stub_port/v1" OPENAI_API_KEY=stub-key HF_HUB_OFFLINE=1 \
	CORS_ALLOW_ORIGIN="http://localhost:$PORT;http://127.0.0.1:$PORT" \
	setsid nohup "$LLLM_TW_REPO/apps/server/.venv/bin/python" -m uvicorn local_llm.main:app \
	--host 127.0.0.1 --port "$PORT" --timeout-graceful-shutdown 10 \
	>"$LLLM_TW_STATE/backend-$PORT.log" 2>&1 &
echo $! >"$LLLM_TW_STATE/backend-$PORT.pid"

for _ in $(seq 1 90); do
	if curl -sf "http://127.0.0.1:$PORT/ready" >/dev/null; then
		echo "backend :$PORT ready (dist $DIST, data $DATA)"
		exit 0
	fi
	sleep 1
done
echo "backend :$PORT did not become ready; see $LLLM_TW_STATE/backend-$PORT.log" >&2
exit 1
