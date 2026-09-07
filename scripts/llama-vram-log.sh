#!/usr/bin/env bash
#
# llama-vram-log.sh - record a llama-server run into logs/llama.db
# Part of https://github.com/epittman23/local-llm
#
# USAGE
#   ./scripts/llama-vram-log.sh record [profile]
#
# Normally started automatically by llama-serve (scripts/llama-env.sh) and
# stopped when the server exits. Run it by hand only to capture a server that
# was started some other way.
#
# This script resolves the profile and computes the configuration fingerprint;
# scripts/llama_record.py does the sampling loop and the writing. The split is
# deliberate: the fingerprint has to be built from the same LLAMA_P_* variables
# llama-serve builds its argv from, which is a shell fact, while waiting on a
# port and committing a row every five seconds is not something to write in
# bash. Everything downstream of the config-id lives in Python now, and with it
# the sample tmpfile, the merge payload and the jq dependency.
#
# The run it opens in logs/llama.db is the active-run marker: a row with
# ended_at IS NULL is how llama-test finds the run its requests belong to. That
# replaces logs/.active-run.json, which an EXIT trap removed and a kill -9
# therefore left behind.
#
# ENVIRONMENT
#   LLAMA_VRAM_LOG=0        disable entirely (honored by llama-serve)
#   LLAMA_VRAM_INTERVAL     seconds between samples (default 5)
#   LLAMA_VRAM_WAIT         seconds to wait for the server to come up (default 600)
#   LLAMA_VRAM_LOGDIR       directory holding llama.db (default <repo>/logs)
#   LLAMA_DB                the database file itself (default $LLAMA_VRAM_LOGDIR/llama.db)
#   LLAMA_VRAM_HEADROOM_MIB free VRAM below which a run is flagged (default 300)
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

# llama.cpp build string, for the per-run row. Benchmark numbers are only
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
# These were the two halves of the old log filename; they are now columns on the
# run row, which is what lets one database hold every model.
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
# These lines ARE the config-id, and they are stored verbatim in config_text
# because that text is what the hash covers. The typed columns beside it are
# parsed back out of it by llama_stats.parse_config_text, so a column cannot
# disagree with the fingerprint. What llama-test actually sent, and what the
# server's load log said, are observations of a run rather than settings, so
# they are recorded against the run and are not fingerprinted: a run that served
# no llama-test request would otherwise be a different configuration from one
# that did.
#
# Unchanged by the move to SQLite, on purpose: a config-id quoted in an older
# log still names the same serving configuration.
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
# record: resolve the configuration, then hand off to llama_record.py
# ---------------------------------------------------------------------------
llama-vram-log() {
    if [[ "${LLAMA_VRAM_LOG:-1}" == "0" ]]; then
        return 0
    fi
    # Deliberately bare python3, not _llama_python: this process outlives every
    # llama-test and must not depend on <repo>/.venv existing.
    local c
    for c in nvidia-smi python3; do
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

    local -a args=(
        --config-id "$VRAMLOG_CFG_ID"
        --alias     "$LLAMA_P_ALIAS"
        --model     "$VRAMLOG_MODEL_NAME"
        --quant     "$VRAMLOG_MODEL_QUANT"
        --build     "$(_vramlog_build)"
        --port      "$LLAMA_PORT"
        --ngl       "$LLAMA_P_NGL"
        --interval  "$LLAMA_VRAM_INTERVAL"
        --wait      "$LLAMA_VRAM_WAIT"
        --server-log "${LLAMA_SERVER_LOG:-}"
    )
    local line
    for line in "${VRAMLOG_CFG_LINES[@]}"; do
        args+=(--config-line "$line")
    done

    # exec so llama-serve's SIGTERM reaches the recorder directly rather than a
    # shell that would have to forward it.
    LLAMA_VRAM_LOGDIR="$LLAMA_VRAM_LOGDIR" \
        exec python3 "$_VRAMLOG_DIR/llama_record.py" "${args[@]}"
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
