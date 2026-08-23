#!/usr/bin/env bash
#
# llama-env.sh - local llama.cpp inference helpers
# Part of https://github.com/epittman23/local-llm
#
# Suggested repo location: scripts/llama-env.sh
#
# USAGE
#   source scripts/llama-env.sh            # load helpers into the current shell
#   ./scripts/llama-env.sh serve qwen38    # or invoke directly, no sourcing needed
#
# To keep this out of your personal dotfiles, add exactly one line to ~/.bashrc:
#   source "$HOME/code/local-llm/scripts/llama-env.sh"
#
# COMMANDS
#   llama-serve [profile] [-- extra llama-server args]
#   llama-sweep-threads [profile] [thread-list]
#   llama-sweep-ngl     [profile] [ngl-list]
#   llama-fetch         [profile]
#   llama-check
#   llama-vram
#   llama-profiles
#
# GPU telemetry is recorded automatically for every llama-serve run by
# scripts/llama-vram-log.sh; see that file's header and README.md.
#
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Paths and global defaults. Every value here is overridable from the
# environment, so nothing in this file needs editing for a one-off run.
# ---------------------------------------------------------------------------
: "${LLAMA_BIN:=$HOME/llama.cpp/build/bin}"
: "${LLAMA_MODELS:=$HOME/models}"
: "${LLAMA_HOST:=0.0.0.0}"
: "${LLAMA_PORT:=8090}"          # 8080 is reserved for work tooling
: "${LLAMA_DEFAULT_PROFILE:=qwen36}"

# Flash attention flag spelling changed in llama.cpp during 2026: older builds
# accept `--flash-attn 1`, current builds accept `-fa on|off|auto`. This script
# uses the current form. If your build predates the change, set LLAMA_FA_LEGACY=1.
: "${LLAMA_FA:=on}"
: "${LLAMA_FA_LEGACY:=0}"

export LLAMA_BIN LLAMA_MODELS LLAMA_HOST LLAMA_PORT

# ---------------------------------------------------------------------------
# Profile definitions
#
# Each profile declares its architecture explicitly. This is the important part:
# --n-cpu-moe is meaningful only for mixture-of-experts models. Qwen3.8-27B is
# dense, so every parameter is read on every forward pass and -ngl must be tuned
# by hand against available VRAM rather than set to 99.
# ---------------------------------------------------------------------------
_llama_profile() {
    local p="${1:-$LLAMA_DEFAULT_PROFILE}"

    # Reset so a previous profile cannot leak flags into this one.
    LLAMA_P_NAME=""; LLAMA_P_ARCH=""; LLAMA_P_MODEL=""; LLAMA_P_REPO=""
    LLAMA_P_PATTERN=""; LLAMA_P_ALIAS=""; LLAMA_P_CTX=""; LLAMA_P_THREADS=""
    LLAMA_P_NGL=""; LLAMA_P_MOE=""; LLAMA_P_SAMPLERS=(); LLAMA_P_EXTRA=()

    case "$p" in
        qwen36|qwen3.6|moe)
            LLAMA_P_NAME="qwen36"
            LLAMA_P_ARCH="moe"
            LLAMA_P_MODEL="$LLAMA_MODELS/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
            LLAMA_P_REPO="unsloth/Qwen3.6-35B-A3B-GGUF"
            LLAMA_P_PATTERN="*UD-Q4_K_XL*"
            LLAMA_P_ALIAS="qwen3.6-35b-a3b"
            LLAMA_P_CTX=65536
            LLAMA_P_THREADS=6
            LLAMA_P_NGL=99          # all layers offloaded; experts live in RAM
            LLAMA_P_MOE=34          # measured optimum on 6 GB VRAM
            ;;

        qwen38|qwen3.8|dense)
            LLAMA_P_NAME="qwen38"
            LLAMA_P_ARCH="dense"
            LLAMA_P_MODEL="$LLAMA_MODELS/qwen38-27b/Qwen3.8-27B-UD-Q3_K_XL.gguf"
            LLAMA_P_REPO="unsloth/Qwen3.8-27B-GGUF"
            LLAMA_P_PATTERN="*UD-Q3_K_XL*"
            LLAMA_P_ALIAS="qwen3.8-27b"
            # Context is deliberately conservative. The model supports 262144,
            # but KV cache competes directly with weights for 6 GB of VRAM.
            LLAMA_P_CTX=16384
            LLAMA_P_THREADS=12
            # PLACEHOLDER. Tune this with llama-sweep-ngl before trusting it.
            # A dense model will fail to allocate at -ngl 99 on this hardware.
            LLAMA_P_NGL=26
            LLAMA_P_MOE=""          # must stay empty: dense has no experts
            # Qwen3.8 thinking-mode recommended sampling.
            LLAMA_P_SAMPLERS=(--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0)
            # xhigh is the model default and is punishing at 3-4 t/s.
            LLAMA_P_EXTRA=(--chat-template-kwargs \
                "{\"reasoning_effort\":\"${LLAMA_REASONING:-medium}\"}")
            ;;

        *)
            echo "llama: unknown profile '$p'" >&2
            echo "known profiles: qwen36, qwen38" >&2
            return 1
            ;;
    esac

    # Environment overrides win over profile defaults.
    [[ -n "${LLAMA_MODEL:-}"   ]] && LLAMA_P_MODEL="$LLAMA_MODEL"
    [[ -n "${LLAMA_CTX:-}"     ]] && LLAMA_P_CTX="$LLAMA_CTX"
    [[ -n "${LLAMA_THREADS:-}" ]] && LLAMA_P_THREADS="$LLAMA_THREADS"
    [[ -n "${LLAMA_NGL:-}"     ]] && LLAMA_P_NGL="$LLAMA_NGL"
    [[ -n "${LLAMA_MOE:-}"     ]] && LLAMA_P_MOE="$LLAMA_MOE"

    # Guard rail: refuse to pass an MoE-only flag to a dense model.
    if [[ "$LLAMA_P_ARCH" == "dense" && -n "$LLAMA_P_MOE" ]]; then
        echo "llama: --n-cpu-moe is not applicable to dense model '$LLAMA_P_NAME'; ignoring" >&2
        LLAMA_P_MOE=""
    fi

    return 0
}

# ---------------------------------------------------------------------------
# llama-profiles: list what is defined and whether the weights are on disk
# ---------------------------------------------------------------------------
llama-profiles() {
    local p
    printf '%-10s %-7s %-9s %s\n' PROFILE ARCH STATUS MODEL
    for p in qwen36 qwen38; do
        ( _llama_profile "$p" >/dev/null 2>&1
          local status="missing"
          [[ -f "$LLAMA_P_MODEL" ]] && status="present"
          printf '%-10s %-7s %-9s %s\n' \
              "$LLAMA_P_NAME" "$LLAMA_P_ARCH" "$status" "$LLAMA_P_MODEL" )
    done
}

# ---------------------------------------------------------------------------
# llama-fetch: download a profile's weights into the WSL filesystem
#
# Deliberately targets $LLAMA_MODELS rather than /mnt/c, which would incur the
# 9p translation penalty on every cold load.
# ---------------------------------------------------------------------------
llama-fetch() {
    _llama_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1

    if ! command -v hf >/dev/null 2>&1; then
        echo "llama-fetch: 'hf' CLI not found. Install with:" >&2
        echo "  pip install -U \"huggingface_hub[cli]\"" >&2
        return 1
    fi

    local dir
    dir="$(dirname "$LLAMA_P_MODEL")"
    echo "llama-fetch: $LLAMA_P_REPO ($LLAMA_P_PATTERN) -> $dir" >&2

    hf download "$LLAMA_P_REPO" \
        --local-dir "$dir" \
        --include "$LLAMA_P_PATTERN"
}

# ---------------------------------------------------------------------------
# llama-serve: start llama-server for a profile
#
#   llama-serve                       # default profile
#   llama-serve qwen38                # named profile
#   llama-serve qwen38 --verbose      # trailing args pass through to llama-server
#   LLAMA_NGL=22 llama-serve qwen38   # one-off override
# ---------------------------------------------------------------------------
llama-serve() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _llama_profile "$profile" || return 1

    if [[ ! -x "$LLAMA_BIN/llama-server" ]]; then
        echo "llama-serve: llama-server not found at $LLAMA_BIN" >&2
        echo "  rebuild, then re-source this script if the path changed" >&2
        return 1
    fi

    if [[ ! -f "$LLAMA_P_MODEL" ]]; then
        echo "llama-serve: model not found: $LLAMA_P_MODEL" >&2
        echo "  run: llama-fetch $LLAMA_P_NAME" >&2
        return 1
    fi

    # Assemble arguments. Architecture-specific flags are added only where valid.
    local -a args=(
        -m "$LLAMA_P_MODEL"
        -ngl "$LLAMA_P_NGL"
        -c "$LLAMA_P_CTX"
        -t "$LLAMA_P_THREADS"
        --cache-type-k q8_0
        --cache-type-v q8_0
        -b 512
        --ubatch-size 512
        --jinja
        --alias "$LLAMA_P_ALIAS"
        --host "$LLAMA_HOST"
        --port "$LLAMA_PORT"
    )

    if [[ "$LLAMA_FA_LEGACY" == "1" ]]; then
        args+=(--flash-attn 1)
    else
        args+=(-fa "$LLAMA_FA")
    fi

    [[ -n "$LLAMA_P_MOE" ]] && args+=(--n-cpu-moe "$LLAMA_P_MOE")
    [[ ${#LLAMA_P_SAMPLERS[@]} -gt 0 ]] && args+=("${LLAMA_P_SAMPLERS[@]}")
    [[ ${#LLAMA_P_EXTRA[@]}    -gt 0 ]] && args+=("${LLAMA_P_EXTRA[@]}")

    echo "llama-serve: profile=$LLAMA_P_NAME arch=$LLAMA_P_ARCH ngl=$LLAMA_P_NGL${LLAMA_P_MOE:+ moe=$LLAMA_P_MOE} ctx=$LLAMA_P_CTX threads=$LLAMA_P_THREADS port=$LLAMA_PORT" >&2

    if [[ "$LLAMA_P_ARCH" == "dense" ]]; then
        echo "llama-serve: dense model. Watch 'n_layer' in the load log and confirm" >&2
        echo "             VRAM headroom with llama-vram before treating -ngl as tuned." >&2
    fi

    # GPU telemetry for the life of this server. The recorder waits for the port,
    # samples until it is killed below, and appends the run to logs/. If Ctrl-C
    # aborts this function before the cleanup runs, it stops on its own once the
    # port stops answering. Set LLAMA_VRAM_LOG=0 to skip it.
    local vram_pid=""
    if [[ "${LLAMA_VRAM_LOG:-1}" != "0" ]] && command -v nvidia-smi >/dev/null 2>&1; then
        local here
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [[ -f "$here/llama-vram-log.sh" ]]; then
            bash "$here/llama-vram-log.sh" record "$LLAMA_P_NAME" &
            vram_pid=$!
        fi
    fi

    "$LLAMA_BIN/llama-server" "${args[@]}" "$@"
    local rc=$?

    if [[ -n "$vram_pid" ]]; then
        kill -TERM "$vram_pid" 2>/dev/null
        wait "$vram_pid" 2>/dev/null
    fi

    return $rc
}

# Backwards-compatible name for the old .bashrc function.
llama-qwen() { llama-serve "$@"; }

# ---------------------------------------------------------------------------
# llama-sweep-threads: generation throughput across thread counts
#
# Worth re-running for the dense profile. The earlier finding that throughput
# plateaus above four threads was measured on a 3B-active MoE, which is almost
# purely bandwidth-bound. A dense 27B does roughly nine times the arithmetic per
# token, so the compute-versus-bandwidth balance shifts and the curve may differ.
# ---------------------------------------------------------------------------
llama-sweep-threads() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != *,* && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _llama_profile "$profile" || return 1

    local threads="${1:-4,6,8,10}"

    local -a args=(-m "$LLAMA_P_MODEL" -t "$threads" -ngl "$LLAMA_P_NGL" -o md)
    [[ -n "$LLAMA_P_MOE" ]] && args+=(--n-cpu-moe "$LLAMA_P_MOE")

    echo "llama-sweep-threads: profile=$LLAMA_P_NAME threads=$threads" >&2
    "$LLAMA_BIN/llama-bench" "${args[@]}"
}

# ---------------------------------------------------------------------------
# llama-sweep-ngl: find the GPU layer count that fills VRAM without spilling
#
# This is the dense-model equivalent of tuning --n-cpu-moe. Start low, walk up,
# and take the highest value that does not fail to allocate or start swapping.
# ---------------------------------------------------------------------------
llama-sweep-ngl() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != *,* && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _llama_profile "$profile" || return 1

    if [[ "$LLAMA_P_ARCH" == "moe" ]]; then
        echo "llama-sweep-ngl: '$LLAMA_P_NAME' is MoE; sweep --n-cpu-moe instead:" >&2
        echo "  $LLAMA_BIN/llama-bench -m \"$LLAMA_P_MODEL\" -ngl 99 --n-cpu-moe 30,32,34,36 -o md" >&2
        return 1
    fi

    local ngl="${1:-12,16,20,24}"

    echo "llama-sweep-ngl: profile=$LLAMA_P_NAME ngl=$ngl" >&2
    echo "  Values that exceed VRAM will error out; that failure is the useful signal." >&2
    "$LLAMA_BIN/llama-bench" \
        -m "$LLAMA_P_MODEL" \
        -ngl "$ngl" \
        -t "$LLAMA_P_THREADS" \
        -p 512 -n 128 \
        -o md
}

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
llama-check() {
    curl -fsS "http://localhost:${LLAMA_PORT}/v1/models" \
        || { echo "llama-check: no server responding on port $LLAMA_PORT" >&2; return 1; }
    echo
}

llama-vram() {
    watch -n 1 nvidia-smi \
        --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.sm \
        --format=csv
}

# ---------------------------------------------------------------------------
# Direct-invocation dispatch. Sourcing this file defines the functions above and
# stops here; executing it runs a subcommand.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    cmd="${1:-serve}"; shift 2>/dev/null || true
    case "$cmd" in
        serve)          llama-serve "$@" ;;
        fetch)          llama-fetch "$@" ;;
        sweep-threads)  llama-sweep-threads "$@" ;;
        sweep-ngl)      llama-sweep-ngl "$@" ;;
        check)          llama-check "$@" ;;
        vram)           llama-vram "$@" ;;
        vram-log)       "$(dirname "${BASH_SOURCE[0]}")/llama-vram-log.sh" record "$@" ;;
        profiles)       llama-profiles "$@" ;;
        *)
            echo "usage: $(basename "$0") {serve|fetch|sweep-threads|sweep-ngl|check|vram|vram-log|profiles} [profile] [args]" >&2
            exit 2
            ;;
    esac
fi