#!/usr/bin/env bash
# Start the stub model (stub.py) on PORT (default 4190) and record the port
# so backend.sh points at it. Log and pid: <state dir>/stub.log and .pid.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PORT=${1:-4190}
case $PORT in
4000 | 5432 | 6379 | 8090)
	echo "refusing port $PORT" >&2
	exit 1
	;;
esac
mkdir -p "$LLLM_TW_STATE"
tw_stop_pidfile "$LLLM_TW_STATE/stub.pid"
if [ -n "$(ss -ltnH "sport = :$PORT")" ]; then
	echo "port $PORT is in use by something this script did not start" >&2
	exit 1
fi

STUB_PORT=$PORT STUB_LOG="$LLLM_TW_STATE/stub-requests.log" \
	setsid nohup "$LLLM_TW_REPO/apps/server/.venv/bin/python" \
	"$(dirname "${BASH_SOURCE[0]}")/stub.py" >"$LLLM_TW_STATE/stub.log" 2>&1 &
echo $! >"$LLLM_TW_STATE/stub.pid"
echo "$PORT" >"$LLLM_TW_STATE/stub.port"

for _ in $(seq 1 20); do
	if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
		echo "stub :$PORT up"
		exit 0
	fi
	sleep 0.5
done
echo "stub :$PORT did not start; see $LLLM_TW_STATE/stub.log" >&2
exit 1
