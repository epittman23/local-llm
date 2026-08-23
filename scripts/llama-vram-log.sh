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
# LLAMA_VRAM_INTERVAL seconds, and on exit appends the run to
#   logs/<model-name>-<quant>.log
# grouped by serving configuration. Only the most recent run of a given
# configuration keeps its full sample table; older runs are collapsed to one
# summary row computed when they finished.
#
# ENVIRONMENT
#   LLAMA_VRAM_LOG=0        disable entirely (honored by llama-serve)
#   LLAMA_VRAM_INTERVAL     seconds between samples (default 5)
#   LLAMA_VRAM_WAIT         seconds to wait for the server to come up (default 600)
#   LLAMA_VRAM_LOGDIR       output directory (default <repo>/logs)
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
# mirror the flags llama-serve actually passes; the build string is deliberately
# excluded so a rebuild does not fragment a configuration's history.
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
        "arch: $LLAMA_P_ARCH | ngl: $LLAMA_P_NGL | ctx: $LLAMA_P_CTX | threads: $LLAMA_P_THREADS | moe: ${LLAMA_P_MOE:-n/a}"
        "cache: k=q8_0 v=q8_0 | fa: $fa | batch: 512 | ubatch: 512"
        "reasoning effort: $effort"
        "samplers: $samplers"
    )
    VRAMLOG_CFG_ID="$(printf '%s\n' "$LLAMA_P_ALIAS" "${VRAMLOG_CFG_LINES[@]}" \
        | sha1sum | cut -c1-8)"
}

# ---------------------------------------------------------------------------
# finalize: summarize the samples and merge them into the log file.
#
# Runs from the EXIT trap, so it is reached whether the server stopped, a
# SIGTERM arrived from llama-serve, or the port probe gave up.
# ---------------------------------------------------------------------------
_vramlog_finalize() {
    trap - EXIT INT TERM

    [[ -s "$VRAMLOG_SAMPLES" ]] || { rm -f "$VRAMLOG_SAMPLES"; return 0; }

    local ended dur summary
    ended="$(_vramlog_epoch)"
    dur="$(printf '%02d:%02d:%02d' \
        $(( (ended - VRAMLOG_START_EPOCH) / 3600 )) \
        $(( (ended - VRAMLOG_START_EPOCH) % 3600 / 60 )) \
        $(( (ended - VRAMLOG_START_EPOCH) % 60 )) )"

    # One summary row: avg/max of each metric across the run.
    summary="$(awk -F'|' -v started="$VRAMLOG_START_ISO" -v dur="$dur" \
                   -v build="$VRAMLOG_BUILD" '
        NR > 1 {
            n++
            t += $2; if ($2 > tm) tm = $2
            u += $3; if ($3 > um) um = $3
            m += $4; if ($4 > mm) mm = $4
            p += $6; if ($6 > pm) pm = $6
            s += $7
        }
        END {
            if (!n) exit 1
            printf "| %s | %s | %d | %s | %.0f/%.0f | %.0f/%.0f | %.0f/%.0f | %.1f/%.1f | %.0f |",
                started, dur, n, build, t/n, tm, u/n, um, m/n, mm, p/n, pm, s/n
        }' "$VRAMLOG_SAMPLES")" || { rm -f "$VRAMLOG_SAMPLES"; return 0; }

    mkdir -p "$VRAMLOG_LOGDIR"

    local tmp="$VRAMLOG_LOG.tmp.$$"
    if [[ ! -f "$VRAMLOG_LOG" ]]; then
        {
            echo "$VRAMLOG_MODEL_NAME"
            echo "$VRAMLOG_MODEL_QUANT"
            _vramlog_emit_block 1 "$summary"
        } > "$tmp"
    else
        _vramlog_merge "$summary" > "$tmp"
    fi
    mv "$tmp" "$VRAMLOG_LOG"

    rm -f "$VRAMLOG_SAMPLES"
    echo "llama-vram-log: wrote $VRAMLOG_LOG (config $VRAMLOG_CFG_ID)" >&2
}

# Emit a complete configuration block: header, config lines, the summary table
# seeded with this run's row, and this run's full sample table.
_vramlog_emit_block() {
    local n="$1" summary="$2"
    echo
    echo "---"
    echo
    echo "## config $n"
    echo "config-id: $VRAMLOG_CFG_ID"
    printf '%s\n' "${VRAMLOG_CFG_LINES[@]}"
    echo
    echo "### previous runs"
    echo "| started (UTC) | duration | samples | build | temp avg/max (C) | util avg/max (%) | mem.used avg/max (MiB) | power avg/max (W) | sm avg (MHz) |"
    echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    echo "$summary"
    echo
    _vramlog_emit_latest
}

# Emit the "latest run" section: this run's samples as a markdown table.
_vramlog_emit_latest() {
    echo "### latest run - $VRAMLOG_START_ISO (build $VRAMLOG_BUILD)"
    echo "| timestamp (UTC) | temp (C) | util (%) | mem.used (MiB) | mem.total (MiB) | power (W) | sm (MHz) |"
    echo "| --- | --- | --- | --- | --- | --- | --- |"
    awk -F'|' 'NR > 1 { printf "| %s | %s | %s | %s | %s | %s | %s |\n",
                        $1, $2, $3, $4, $5, $6, $7 }' "$VRAMLOG_SAMPLES"
}

# Merge into an existing log. If this configuration already has a block, replace
# its "latest run" section and append the summary row; otherwise append a new
# block after everything else.
_vramlog_merge() {
    local summary="$1"

    if ! grep -q "^config-id: $VRAMLOG_CFG_ID\$" "$VRAMLOG_LOG"; then
        local n
        n=$(( $(grep -c '^config-id: ' "$VRAMLOG_LOG") + 1 ))
        # Trim trailing blank lines so blocks stay uniformly spaced.
        awk 'BEGIN { blanks = 0 }
             /^[[:space:]]*$/ { blanks++; next }
             { while (blanks-- > 0) print ""; blanks = 0; print }' "$VRAMLOG_LOG"
        _vramlog_emit_block "$n" "$summary"
        return 0
    fi

    local latest
    latest="$(_vramlog_emit_latest)"

    awk -v id="$VRAMLOG_CFG_ID" -v summary="$summary" -v latest="$latest" '
        # Blank lines inside our block are held back so the new summary row can
        # be appended directly to the end of the summary table.
        function release_blanks(   i) {
            for (i = 0; i < blanks; i++) print ""
            blanks = 0
        }
        function emit_run() {
            if (!done) { print summary; print ""; print latest; print ""; done = 1 }
        }
        # A separator ends the current block. If it was ours and nothing has been
        # written yet (a block with no latest-run section), append the run here.
        /^---[[:space:]]*$/ {
            if (mine) { emit_run(); mine = 0; skip = 0; blanks = 0 }
            print
            next
        }
        /^config-id: / {
            mine = ($0 == "config-id: " id)
            skip = 0; blanks = 0
            print
            next
        }
        # The old latest-run section is dropped: its summary row was recorded
        # when it finished, so only this run keeps a full table.
        mine && /^### latest run/ { blanks = 0; skip = 1; emit_run(); next }
        mine && skip { next }
        mine && /^[[:space:]]*$/ { blanks++; next }
        mine { release_blanks(); print; next }
        { print }
        END { if (mine) emit_run() }
    ' "$VRAMLOG_LOG"
}

# ---------------------------------------------------------------------------
# record: the sampling loop
# ---------------------------------------------------------------------------
llama-vram-log() {
    if [[ "${LLAMA_VRAM_LOG:-1}" == "0" ]]; then
        return 0
    fi
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        echo "llama-vram-log: nvidia-smi not found; not recording" >&2
        return 0
    fi

    _llama_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1
    _vramlog_config

    local base
    base="$(basename "$LLAMA_P_MODEL")"; base="${base%.gguf}"
    _vramlog_split_model "$base"

    VRAMLOG_LOGDIR="$LLAMA_VRAM_LOGDIR"
    VRAMLOG_LOG="$VRAMLOG_LOGDIR/${VRAMLOG_MODEL_NAME}-${VRAMLOG_MODEL_QUANT}.log"
    VRAMLOG_BUILD="$(_vramlog_build)"
    VRAMLOG_SAMPLES="$(mktemp "${TMPDIR:-/tmp}/llama-vram-log.XXXXXX")"

    # Wait for the server to bind its port. A model this size can take minutes to
    # load, and samples taken before it is up describe nothing useful.
    local waited=0
    while ! _vramlog_port_open; do
        (( waited >= LLAMA_VRAM_WAIT )) && {
            echo "llama-vram-log: no server on port $LLAMA_PORT after ${LLAMA_VRAM_WAIT}s; giving up" >&2
            rm -f "$VRAMLOG_SAMPLES"
            return 0
        }
        sleep 1
        waited=$(( waited + 1 ))
    done

    VRAMLOG_START_ISO="$(_vramlog_now)"
    VRAMLOG_START_EPOCH="$(_vramlog_epoch)"
    echo "# samples" > "$VRAMLOG_SAMPLES"

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
