#!/usr/bin/env bash
#
# llama-vram-log.sh - record GPU telemetry for the life of a llama-server run
# Part of https://github.com/epittman23/local-llm
#
# USAGE
#   ./scripts/llama-vram-log.sh record [profile]
#
# Normally started automatically by llama-serve (scripts/llama-env.sh) and
# stopped when the server exits. Run it by hand only to capture a server that
# was started some other way.
#
# It waits for the server's port to open, samples nvidia-smi every
# LLAMA_VRAM_INTERVAL seconds, scrapes the server's /metrics counters, and on
# exit hands the run to scripts/llama_log.py, which appends it to
#   logs/<model-name>-<quant>.log
# grouped by serving configuration. Only the most recent run of a given
# configuration keeps its full sample and request tables; older runs are
# collapsed to summary rows computed when they finished.
#
# While recording it publishes logs/.active-run.json, which is how llama-test
# finds the run its request timings belong to.
#
# ENVIRONMENT
#   LLAMA_VRAM_LOG=0        disable entirely (honored by llama-serve)
#   LLAMA_VRAM_INTERVAL     seconds between samples (default 5)
#   LLAMA_VRAM_WAIT         seconds to wait for the server to come up (default 600)
#   LLAMA_VRAM_LOGDIR       output directory (default <repo>/logs)
#   LLAMA_SERVER_LOG        llama-server's own output, tee'd there by llama-serve;
#                           parsed for what the server said about the model it
#                           loaded (layer split, slots, fused kernels, warnings)
#
# ---------------------------------------------------------------------------

set -uo pipefail

_VRAMLOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Profile definitions live in llama-env.sh. Sourcing it only defines functions;
# its dispatch block is guarded on BASH_SOURCE[0] == $0.
# shellcheck source=./llama-env.sh
source "$_VRAMLOG_DIR/llama-env.sh"

: "${LLAMA_VRAM_INTERVAL:=5}"
: "${LLAMA_VRAM_WAIT:=600}"
: "${LLAMA_VRAM_LOGDIR:=$(cd "$_VRAMLOG_DIR/.." && pwd)/logs}"

# Consecutive failed port probes before concluding the server is gone. This is
# the fallback stop condition; the normal one is a SIGTERM from llama-serve.
_VRAMLOG_MISS_LIMIT=3

_vramlog_now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
_vramlog_epoch() { date -u +%s; }

# Is anything listening on $LLAMA_PORT?
_vramlog_port_open() {
    ss -ltn "sport = :$LLAMA_PORT" 2>/dev/null | grep -q LISTEN
}

# llama.cpp build string, for the per-run header. Benchmark numbers are only
# reusable alongside the build that produced them (see CLAUDE.md).
_vramlog_build() {
    local out commit="" build=""
    out="$("$LLAMA_BIN/llama-server" --version 2>&1 | head -20)"

    # Two spellings in the wild:
    #   "version: 0.2.0-dev (build 10597, commit 95b8e33e1)"   (current)
    #   "version: 10472 (60eeeb608)"                           (older builds)
    if [[ "$out" =~ commit[[:space:]]+([0-9a-f]{7,}) ]]; then
        commit="${BASH_REMATCH[1]}"
    elif [[ "$out" =~ version:[[:space:]]*[0-9]+[[:space:]]*\(([0-9a-f]{7,})\) ]]; then
        commit="${BASH_REMATCH[1]}"
    fi
    if [[ "$out" =~ build[[:space:]]+([0-9]+) ]]; then
        build="${BASH_REMATCH[1]}"
    elif [[ "$out" =~ version:[[:space:]]*([0-9]+)[[:space:]]*\( ]]; then
        build="${BASH_REMATCH[1]}"
    fi

    if [[ -n "$commit" && -n "$build" ]]; then
        echo "$commit ($build)"
    else
        echo "${commit:-${build:-unknown}}"
    fi
}

# Split a GGUF basename into model name and quantization. The quant is the
# first field that looks like one: UD-Q4_K_XL, Q3_K_XL, IQ2_M, BF16, F16...
_vramlog_split_model() {
    local base="$1" i n
    local -a f
    IFS='-' read -r -a f <<< "$base"
    n=${#f[@]}
    for (( i = 0; i < n; i++ )); do
        if [[ "${f[i]}" =~ ^(UD|I?Q[0-9]|BF16|F16|F32)$ ]] \
           || [[ "${f[i]}" =~ ^I?Q[0-9] ]]; then
            VRAMLOG_MODEL_NAME="$(IFS=-; echo "${f[*]:0:i}")"
            VRAMLOG_MODEL_QUANT="$(IFS=-; echo "${f[*]:i}")"
            return 0
        fi
    done
    VRAMLOG_MODEL_NAME="$base"
    VRAMLOG_MODEL_QUANT="unknown"
}

# Build the human-readable configuration lines and their fingerprint. These must
# mirror the flags llama-serve actually passes -- they are read from the same
# LLAMA_P_* variables llama-serve builds its argv from, so the two cannot drift.
# The build string is deliberately excluded so a rebuild does not fragment a
# configuration's history, as are --metrics and -lv, which change what the server
# reports about itself but not what it computes.
#
# These lines are the fingerprint, and llama_log.py renders them under "server
# flags:". The other groups in a block's header -- what llama-test actually sent,
# and what the server's load log said -- are observations of a run, not settings,
# so they are recorded but not fingerprinted: a run that served no llama-test
# request would otherwise be a different configuration from one that did.
_vramlog_config() {
    local fa="on"
    [[ "$LLAMA_FA_LEGACY" == "1" ]] && fa="legacy --flash-attn 1"
    [[ "$LLAMA_FA_LEGACY" != "1" ]] && fa="$LLAMA_FA"

    # --temp 1.0 --top-p 0.95 ... -> "temp 1.0 | top-p 0.95 | ..."
    local samplers="llama.cpp defaults"
    if [[ ${#LLAMA_P_SAMPLERS[@]} -gt 0 ]]; then
        local i sep=""
        samplers=""
        for (( i = 0; i < ${#LLAMA_P_SAMPLERS[@]}; i += 2 )); do
            samplers+="${sep}${LLAMA_P_SAMPLERS[i]#--} ${LLAMA_P_SAMPLERS[i+1]:-}"
            sep=" | "
        done
    fi

    local effort="n/a"
    if [[ "${LLAMA_P_EXTRA[*]:-}" == *reasoning_effort* ]]; then
        effort="${LLAMA_REASONING:-medium}"
    fi

    VRAMLOG_CFG_LINES=(
        "arch: $LLAMA_P_ARCH | ngl: $LLAMA_P_NGL | ctx: $LLAMA_P_CTX (total) | parallel: ${LLAMA_P_PARALLEL:-1} | threads: $LLAMA_P_THREADS | moe: ${LLAMA_P_MOE:-n/a}"
        "override-tensors: ${LLAMA_P_OT:-n/a}"
        "speculative: ${LLAMA_P_SPEC[*]:-off}"
        "cache: k=${LLAMA_P_CACHE_K:-q8_0} v=${LLAMA_P_CACHE_V:-q8_0} | fa: $fa | batch: ${LLAMA_P_BATCH:-512} | ubatch: ${LLAMA_P_UBATCH:-512}"
        "reasoning effort: $effort"
        "samplers: $samplers"
    )
    VRAMLOG_CFG_ID="$(printf '%s\n' "$LLAMA_P_ALIAS" "${VRAMLOG_CFG_LINES[@]}" \
        | sha1sum | cut -c1-8)"
}

# ---------------------------------------------------------------------------
# /metrics: cumulative counters covering every client of the server, not just
# llama-test. Scraped once when sampling starts and refreshed on each pass, so a
# server that dies still leaves a usable end scrape. The endpoint only exists if
# llama-serve passed --metrics.
# ---------------------------------------------------------------------------
_vramlog_scrape_metrics() {
    local out="$1" body
    body="$(curl -sS --connect-timeout 2 --max-time 5 \
        "http://localhost:$LLAMA_PORT/metrics" 2>/dev/null)" || return 1
    [[ "$body" == \#* ]] || return 1     # a JSON error means --metrics is off
    printf '%s\n' "$body" > "$out"
}

# ---------------------------------------------------------------------------
# finalize: hand the run to llama_log.py, which owns the log file's structure,
# statistics and formatting.
#
# Runs from the EXIT trap, so it is reached whether the server stopped, a
# SIGTERM arrived from llama-serve, or the port probe gave up.
# ---------------------------------------------------------------------------
_vramlog_finalize() {
    trap - EXIT INT TERM

    rm -f "$VRAMLOG_MARKER"

    if [[ ! -s "$VRAMLOG_SAMPLES" ]]; then
        rm -f "$VRAMLOG_SAMPLES" "$VRAMLOG_METRICS_START" "$VRAMLOG_METRICS_END"
        return 0
    fi

    local ended dur
    ended="$(_vramlog_epoch)"
    dur="$(printf '%02d:%02d:%02d' \
        $(( (ended - VRAMLOG_START_EPOCH) / 3600 )) \
        $(( (ended - VRAMLOG_START_EPOCH) % 3600 / 60 )) \
        $(( (ended - VRAMLOG_START_EPOCH) % 60 )) )"

    # One last scrape in case the server is still up; otherwise the newest one
    # taken during the loop stands.
    _vramlog_scrape_metrics "$VRAMLOG_METRICS_END" 2>/dev/null

    mkdir -p "$VRAMLOG_LOGDIR"

    if jq -n \
        --arg log "$VRAMLOG_LOG" \
        --arg model "$VRAMLOG_MODEL_NAME" \
        --arg quant "$VRAMLOG_MODEL_QUANT" \
        --arg id "$VRAMLOG_CFG_ID" \
        --arg started "$VRAMLOG_START_ISO" \
        --arg dur "$dur" \
        --arg build "$VRAMLOG_BUILD" \
        --arg samples "$VRAMLOG_SAMPLES" \
        --arg requests "$VRAMLOG_REQUESTS" \
        --arg mstart "$VRAMLOG_METRICS_START" \
        --arg mend "$VRAMLOG_METRICS_END" \
        --arg slog "${LLAMA_SERVER_LOG:-}" \
        --args '
        {
            log: $log, model: $model, quant: $quant,
            config_id: $id, config_lines: $ARGS.positional,
            started: $started, duration: $dur, build: $build,
            samples: $samples, requests: $requests,
            metrics_start: $mstart, metrics_end: $mend,
            server_log: $slog
        }' "${VRAMLOG_CFG_LINES[@]}" \
        | python3 "$_VRAMLOG_DIR/llama_log.py" merge
    then
        echo "llama-vram-log: wrote $VRAMLOG_LOG (config $VRAMLOG_CFG_ID)" >&2
    else
        echo "llama-vram-log: failed to write $VRAMLOG_LOG; samples kept at $VRAMLOG_SAMPLES" >&2
        return 0
    fi

    rm -f "$VRAMLOG_SAMPLES" "$VRAMLOG_REQUESTS" \
          "$VRAMLOG_METRICS_START" "$VRAMLOG_METRICS_END"
}

# ---------------------------------------------------------------------------
# record: the sampling loop
# ---------------------------------------------------------------------------
llama-vram-log() {
    if [[ "${LLAMA_VRAM_LOG:-1}" == "0" ]]; then
        return 0
    fi
    local c
    for c in nvidia-smi jq python3; do
        command -v "$c" >/dev/null 2>&1 || {
            echo "llama-vram-log: '$c' not found; not recording" >&2
            return 0
        }
    done

    _llama_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1
    _vramlog_config

    local base
    base="$(basename "$LLAMA_P_MODEL")"; base="${base%.gguf}"
    _vramlog_split_model "$base"

    VRAMLOG_LOGDIR="$LLAMA_VRAM_LOGDIR"
    VRAMLOG_LOG="$VRAMLOG_LOGDIR/${VRAMLOG_MODEL_NAME}-${VRAMLOG_MODEL_QUANT}.log"
    VRAMLOG_BUILD="$(_vramlog_build)"
    VRAMLOG_SAMPLES="$(mktemp "${TMPDIR:-/tmp}/llama-vram-log.XXXXXX")"
    VRAMLOG_METRICS_START="$(mktemp "${TMPDIR:-/tmp}/llama-metrics.XXXXXX")"
    VRAMLOG_METRICS_END="$(mktemp "${TMPDIR:-/tmp}/llama-metrics.XXXXXX")"
    VRAMLOG_MARKER="$VRAMLOG_LOGDIR/.active-run.json"
    VRAMLOG_REQUESTS="$VRAMLOG_LOGDIR/.requests.$$.jsonl"

    # Wait for the server to bind its port. A model this size can take minutes to
    # load, and samples taken before it is up describe nothing useful.
    local waited=0
    while ! _vramlog_port_open; do
        (( waited >= LLAMA_VRAM_WAIT )) && {
            echo "llama-vram-log: no server on port $LLAMA_PORT after ${LLAMA_VRAM_WAIT}s; giving up" >&2
            rm -f "$VRAMLOG_SAMPLES" "$VRAMLOG_METRICS_START" "$VRAMLOG_METRICS_END"
            return 0
        }
        sleep 1
        waited=$(( waited + 1 ))
    done

    VRAMLOG_START_ISO="$(_vramlog_now)"
    VRAMLOG_START_EPOCH="$(_vramlog_epoch)"
    echo "# samples" > "$VRAMLOG_SAMPLES"

    # The baseline for this run's server totals. /metrics answers only once the
    # model is loaded, which is later than the port opening, so this first attempt
    # usually fails and the sampling loop retries it.
    _vramlog_scrape_metrics "$VRAMLOG_METRICS_START" 2>/dev/null

    # Announce the run so llama-test can attach its request timings to it without
    # re-deriving the configuration. Removed in _vramlog_finalize.
    mkdir -p "$VRAMLOG_LOGDIR"
    : > "$VRAMLOG_REQUESTS"
    jq -n --arg log "$VRAMLOG_LOG" --arg id "$VRAMLOG_CFG_ID" \
          --arg req "$VRAMLOG_REQUESTS" --arg port "$LLAMA_PORT" \
          --arg started "$VRAMLOG_START_ISO" \
          --arg slog "${LLAMA_SERVER_LOG:-}" \
          '{log: $log, config_id: $id, requests: $req, port: $port,
            started: $started, server_log: $slog}' \
        > "$VRAMLOG_MARKER"

    trap '_vramlog_finalize; exit 0' EXIT INT TERM

    local misses=0 row
    while :; do
        # Probe before sampling, so telemetry from after the server exited is
        # never attributed to the run.
        if _vramlog_port_open; then
            misses=0
        else
            misses=$(( misses + 1 ))
            (( misses >= _VRAMLOG_MISS_LIMIT )) && break
            sleep 1
            continue
        fi

        row="$(nvidia-smi \
            --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.sm \
            --format=csv,noheader,nounits 2>/dev/null | head -1)"
        if [[ -n "$row" ]]; then
            # "63, 95, 5907, 6144, 29.75, 1455" -> pipe-separated, with a timestamp
            echo "$(_vramlog_now)|$(echo "$row" | sed 's/[[:space:]]*,[[:space:]]*/|/g')" \
                >> "$VRAMLOG_SAMPLES"
        fi

        # The baseline first, retried until /metrics answers; after that the end
        # scrape is refreshed every pass, so a server that dies between samples
        # still leaves one close to when it stopped serving.
        if [[ ! -s "$VRAMLOG_METRICS_START" ]]; then
            _vramlog_scrape_metrics "$VRAMLOG_METRICS_START" 2>/dev/null
        else
            _vramlog_scrape_metrics "$VRAMLOG_METRICS_END" 2>/dev/null
        fi

        sleep "$LLAMA_VRAM_INTERVAL"
    done

    _vramlog_finalize
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    cmd="${1:-record}"; shift 2>/dev/null || true
    case "$cmd" in
        record) llama-vram-log "$@" ;;
        *)
            echo "usage: $(basename "$0") record [profile]" >&2
            exit 2
            ;;
    esac
fi
