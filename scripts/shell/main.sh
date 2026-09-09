#!/usr/bin/env bash
#
# main.sh - local-llm shell orchestrator (llama.cpp inference + Open WebUI dev)
# Part of https://github.com/epittman23/local-llm
#
# Suggested repo location: scripts/shell/main.sh
#
# USAGE
#   source scripts/shell/main.sh            # load helpers into the current shell
#   ./scripts/shell/main.sh serve qwen38     # or invoke directly, no sourcing needed
#
# To keep this out of your personal dotfiles, add exactly one line to ~/.bashrc:
#   source "$HOME/code/local-llm/scripts/shell/main.sh"
#
# COMMANDS
#   lllm-serve [profile] [-- extra llama-server args]
#   lllm-frontend                           # Open WebUI fork's vite dev server
#                                            # (localhost:5173), proxying API/WS
#                                            # calls to lllm-backend
#   lllm-backend                            # Open WebUI fork's backend
#                                            # (uvicorn, localhost:4000) plus the
#                                            # Postgres+pgvector container it
#                                            # depends on; tearing this down also
#                                            # tears Postgres down (see the trap
#                                            # inside the function)
#   lllm-sweep-threads [profile] [thread-list]
#   lllm-sweep-ngl     [profile] [ngl-list]
#   lllm-fetch         [profile]            # model weights, not test data
#   lllm-check
#   lllm-vram
#   lllm-profiles
#   lllm-profile-names
#   lllm-config-id     [profile]            # the fingerprint, without serving
#
# Benchmark running/grading/comparison/reporting/tuning (previously
# lllm-test/lllm-tune/lllm-web/lllm-report/lllm-db here) now live in the
# Open WebUI fork's own "Benchmarks" section at /benchmarks, served by
# lllm-frontend/lllm-backend -- see docs/CLAUDE.md's decisions log. GPU
# telemetry and request timings from lllm-serve still go into that same
# app's Postgres, written by scripts/shell/vram-log.sh via
# open_webui.benchmarks.telemetry_recorder, not logs/llama.db (retired).
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
: "${LLAMA_DEFAULT_PROFILE:=qwen38}"
# This file now lives at scripts/shell/main.sh, two directories below the
# repo root -- one more ".." than when it was scripts/llama-env.sh.
: "${LLAMA_REPO:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Flash attention flag spelling changed in llama.cpp during 2026: older builds
# accept `--flash-attn 1`, current builds accept `-fa on|off|auto`. This script
# uses the current form. If your build predates the change, set LLAMA_FA_LEGACY=1.
: "${LLAMA_FA:=on}"
: "${LLAMA_FA_LEGACY:=0}"

export LLAMA_BIN LLAMA_MODELS LLAMA_HOST LLAMA_PORT LLAMA_REPO

# Every profile _lllm_profile knows about, in the order diagnostics list them.
# Declared once here rather than repeated in each place that enumerates them:
# the two Python front ends read it back through `profile-names` below, so
# adding a profile means editing this file and nothing else.
LLAMA_PROFILE_NAMES=(qwen38 qwen36 qwen25c qwen3c)

# ---------------------------------------------------------------------------
# Profile definitions
#
# Each profile declares its architecture explicitly. This is the important part:
# --n-cpu-moe is meaningful only for mixture-of-experts models. Qwen3.8-27B is
# dense, so every parameter is read on every forward pass and -ngl must be tuned
# by hand against available VRAM rather than set to 99.
# ---------------------------------------------------------------------------
_lllm_profile() {
    local p="${1:-$LLAMA_DEFAULT_PROFILE}"

    # Reset so a previous profile cannot leak flags into this one.
    LLAMA_P_NAME=""; LLAMA_P_ARCH=""; LLAMA_P_MODEL=""; LLAMA_P_REPO=""
    LLAMA_P_PATTERN=""; LLAMA_P_ALIAS=""; LLAMA_P_CTX=""; LLAMA_P_THREADS=""
    LLAMA_P_NGL=""; LLAMA_P_MOE=""; LLAMA_P_OT=""; LLAMA_P_PARALLEL=""
    LLAMA_P_CACHE_K=""; LLAMA_P_CACHE_V=""; LLAMA_P_BATCH=""; LLAMA_P_UBATCH=""
    LLAMA_P_SPEC=(); LLAMA_P_SAMPLERS=(); LLAMA_P_EXTRA=()

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
            # PLACEHOLDER. Tune this with lllm-sweep-ngl before trusting it.
            # A dense model will fail to allocate at -ngl 99 on this hardware.
            LLAMA_P_NGL=20
            LLAMA_P_MOE=""          # must stay empty: dense has no experts
            # -ot: pin specific tensors to the GPU regardless of -ngl. The
            # output projection and the last block (65 blocks: blk.0-blk.64)
            # are hot on every token, so they earn their VRAM even when most
            # layers stay on the CPU.
            LLAMA_P_OT="output\.weight=CUDA0,blk\.64\..*=CUDA0"
            # Speculative decoding off the model's own MTP head: the weights
            # carry qwen35.nextn_predict_layers=1 and blk.64.nextn.* tensors,
            # so no separate draft model is needed. That head sits in blk.64,
            # which -ot above already pins to the GPU. n-max 2 is conservative:
            # rejected drafts cost real compute on a CPU-bound model. The slot
            # count is NOT set here; see LLAMA_P_PARALLEL below for why.
            LLAMA_P_SPEC=(--spec-type draft-mtp --spec-draft-n-max 2)
            # Qwen3.8 thinking-mode recommended sampling.
            LLAMA_P_SAMPLERS=(--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0)
            # xhigh is the model default and is punishing at 3-4 t/s.
            LLAMA_P_EXTRA=(--chat-template-kwargs \
                "{\"reasoning_effort\":\"${LLAMA_REASONING:-medium}\"}")
            ;;

        qwen25c|qwen2.5-coder|coder-2.5)
            LLAMA_P_NAME="qwen25c"
            LLAMA_P_ARCH="dense"
            LLAMA_P_MODEL="$LLAMA_MODELS/qwen25-coder-7b/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
            LLAMA_P_REPO="unsloth/Qwen2.5-Coder-7B-Instruct-GGUF"
            LLAMA_P_PATTERN="*Q4_K_M*"
            LLAMA_P_ALIAS="qwen2.5-coder-7b"
            # The first profile here whose weights fit in VRAM outright: 4.36
            # GiB of 6, so -ngl 99 puts all 28 blocks and the output head on the
            # GPU and nothing is read from system RAM. There is no -ngl to tune
            # and no -ot to pin; those exist above only because those models are
            # 3-5x the size of this card.
            LLAMA_P_NGL=99
            LLAMA_P_MOE=""          # must stay empty: dense has no experts
            # 16384, not the model's full 32768. This GGUF is 28 layers with 4
            # KV heads of 128, so a q8_0 KV cache costs ~29.7 KiB/token: ~476
            # MiB at 16K, ~952 MiB at 32K, on top of 4.36 GiB of weights and the
            # compute buffer. The full window fits inside 6 GiB only with less
            # room to spare than LLAMA_VRAM_HEADROOM_MIB warns at. Raise it with
            # LLAMA_CTX and confirm with lllm-vram if you need the context more
            # than the margin.
            LLAMA_P_CTX=16384
            LLAMA_P_THREADS=6       # batch assembly only; no layer runs on CPU
            # Qwen2.5-Coder's own generation_config.json, which is not the
            # Qwen3.8 thinking-mode set above. lllm-test pins temperature to 0
            # in its request body regardless, so these govern Open WebUI traffic.
            LLAMA_P_SAMPLERS=(--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1)
            # No LLAMA_P_SPEC: Qwen2.5 predates the nextn/MTP tensors qwen38
            # drafts from, and no draft model is worth 4.36 GiB of this card.
            # No LLAMA_P_EXTRA: not a thinking model, so there is no
            # reasoning_effort to set and no reasoning_content in its responses.
            ;;

        qwen3c|qwen3.0-coder|coder-3)
            LLAMA_P_NAME="qwen3c"
            LLAMA_P_ARCH="moe"
            LLAMA_P_MODEL="$LLAMA_MODELS/qwen3-coder-30b-a3b/Qwen3-Coder-30B-A3B-Instruct-Q4_1.gguf"
            LLAMA_P_REPO="unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
            LLAMA_P_PATTERN="*Q4_1*"
            LLAMA_P_ALIAS="qwen3-coder-30b-a3b"
            LLAMA_P_CTX=65536
            LLAMA_P_THREADS=6
            LLAMA_P_NGL=99          # all layers offloaded; experts live in RAM
            LLAMA_P_MOE=34          # measured optimum on 6 GB VRAM
            ;;

        *)
            echo "lllm: unknown profile '$p'" >&2
            echo "known profiles: ${LLAMA_PROFILE_NAMES[*]}" >&2
            return 1
            ;;
    esac

    # Server slots, always passed. This must never live in LLAMA_P_SPEC, because
    # dropping the speculative flags would drop the slot count with them. Omitting
    # --parallel is not "the default 1": llama-server defaults it to -1 = auto,
    # and auto means 4 slots *and* kv_unified = true (llama.cpp build 10597:
    # common/arg.cpp:1400, tools/server/server.cpp:152-155). So an LLAMA_SPEC=off
    # run without this would serve a different attention/KV configuration than the
    # speculative run it is supposed to be the baseline for -- measured here as
    # 15.63 t/s prefill at n_slots=4 against 26.38 t/s at n_slots=1.
    : "${LLAMA_P_PARALLEL:=1}"

    # KV cache types and batch sizes. These are profile variables rather than
    # literals in lllm-serve so that the flags actually passed and the flags
    # recorded in the telemetry log come from one place and cannot drift apart.
    : "${LLAMA_P_CACHE_K:=q8_0}"
    : "${LLAMA_P_CACHE_V:=q8_0}"
    : "${LLAMA_P_BATCH:=512}"
    : "${LLAMA_P_UBATCH:=512}"

    # Environment overrides win over profile defaults.
    [[ -n "${LLAMA_MODEL:-}"   ]] && LLAMA_P_MODEL="$LLAMA_MODEL"
    [[ -n "${LLAMA_CTX:-}"     ]] && LLAMA_P_CTX="$LLAMA_CTX"
    [[ -n "${LLAMA_THREADS:-}" ]] && LLAMA_P_THREADS="$LLAMA_THREADS"
    [[ -n "${LLAMA_NGL:-}"     ]] && LLAMA_P_NGL="$LLAMA_NGL"
    [[ -n "${LLAMA_MOE:-}"     ]] && LLAMA_P_MOE="$LLAMA_MOE"
    [[ -n "${LLAMA_OT:-}"      ]] && LLAMA_P_OT="$LLAMA_OT"
    [[ -n "${LLAMA_PARALLEL:-}" ]] && LLAMA_P_PARALLEL="$LLAMA_PARALLEL"
    [[ -n "${LLAMA_CACHE_K:-}"  ]] && LLAMA_P_CACHE_K="$LLAMA_CACHE_K"
    [[ -n "${LLAMA_CACHE_V:-}"  ]] && LLAMA_P_CACHE_V="$LLAMA_CACHE_V"
    [[ -n "${LLAMA_BATCH:-}"    ]] && LLAMA_P_BATCH="$LLAMA_BATCH"
    [[ -n "${LLAMA_UBATCH:-}"   ]] && LLAMA_P_UBATCH="$LLAMA_UBATCH"
    # LLAMA_SPEC replaces the profile's speculative-decoding flags wholesale;
    # LLAMA_SPEC=off turns them off, which is the A/B this exists for.
    if [[ -n "${LLAMA_SPEC+x}" ]]; then
        if [[ -z "$LLAMA_SPEC" || "$LLAMA_SPEC" == "off" ]]; then
            LLAMA_P_SPEC=()
        else
            read -ra LLAMA_P_SPEC <<< "$LLAMA_SPEC"
        fi
    fi

    # Guard rail: --parallel via LLAMA_SPEC would be passed twice and would be
    # recorded as the profile's slot count rather than the served one, which is
    # the exact confusion LLAMA_P_PARALLEL exists to end.
    if [[ " ${LLAMA_P_SPEC[*]:-} " == *" --parallel "* ]]; then
        echo "lllm: --parallel does not belong in LLAMA_SPEC; use LLAMA_PARALLEL=N" >&2
        return 1
    fi

    # Guard rail: refuse to pass an MoE-only flag to a dense model.
    if [[ "$LLAMA_P_ARCH" == "dense" && -n "$LLAMA_P_MOE" ]]; then
        echo "lllm: --n-cpu-moe is not applicable to dense model '$LLAMA_P_NAME'; ignoring" >&2
        LLAMA_P_MOE=""
    fi

    return 0
}

# ---------------------------------------------------------------------------
# lllm-profiles: list what is defined and whether the weights are on disk
# ---------------------------------------------------------------------------
lllm-profiles() {
    local py; py="$(_lllm_python 2>/dev/null)"
    if [[ -n "$py" && -f "$LLAMA_REPO/scripts/llama_console.py" ]]; then
        "$py" "$LLAMA_REPO/scripts/llama_console.py" profiles
        return $?
    fi
    # Fallback: no Python at all. Diagnostics have to work in exactly the
    # circumstances that break everything else, so this path is kept, not
    # deleted as redundant.
    local p
    printf '%-10s %-7s %-9s %s\n' PROFILE ARCH STATUS MODEL
    for p in "${LLAMA_PROFILE_NAMES[@]}"; do
        ( _lllm_profile "$p" >/dev/null 2>&1
          local status="missing"
          [[ -f "$LLAMA_P_MODEL" ]] && status="present"
          printf '%-10s %-7s %-9s %s\n' \
              "$LLAMA_P_NAME" "$LLAMA_P_ARCH" "$status" "$LLAMA_P_MODEL" )
    done
}

# ---------------------------------------------------------------------------
# lllm-fetch: download a profile's weights into the WSL filesystem
#
# Deliberately targets $LLAMA_MODELS rather than /mnt/c, which would incur the
# 9p translation penalty on every cold load.
# ---------------------------------------------------------------------------
lllm-fetch() {
    _lllm_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1

    if ! command -v hf >/dev/null 2>&1; then
        echo "lllm-fetch: 'hf' CLI not found. Install with:" >&2
        echo "  pip install -U \"huggingface_hub[cli]\"" >&2
        return 1
    fi

    local dir
    dir="$(dirname "$LLAMA_P_MODEL")"
    echo "lllm-fetch: $LLAMA_P_REPO ($LLAMA_P_PATTERN) -> $dir" >&2

    hf download "$LLAMA_P_REPO" \
        --local-dir "$dir" \
        --include "$LLAMA_P_PATTERN"
}

# ---------------------------------------------------------------------------
# lllm-serve: start llama-server for a profile
#
#   lllm-serve                       # default profile
#   lllm-serve qwen38                # named profile
#   lllm-serve qwen38 --verbose      # trailing args pass through to llama-server
#   LLAMA_NGL=22 lllm-serve qwen38   # one-off override
# ---------------------------------------------------------------------------
lllm-serve() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _lllm_profile "$profile" || return 1

    if [[ ! -x "$LLAMA_BIN/llama-server" ]]; then
        echo "lllm-serve: llama-server not found at $LLAMA_BIN" >&2
        echo "  rebuild, then re-source this script if the path changed" >&2
        return 1
    fi

    if [[ ! -f "$LLAMA_P_MODEL" ]]; then
        echo "lllm-serve: model not found: $LLAMA_P_MODEL" >&2
        echo "  run: lllm-fetch $LLAMA_P_NAME" >&2
        return 1
    fi

    # Assemble arguments. Architecture-specific flags are added only where valid.
    # --metrics exposes /metrics, which vram-log.sh scrapes for the run's
    # server-wide token totals. -lv 4 is what makes llama.cpp print the model
    # load detail the telemetry block records (n_layer, the GPU/CPU layer split,
    # buffer sizes, resolve_fused_ops); at the default 3 those lines never appear
    # and the block records them as unavailable. Neither flag changes inference,
    # so neither is part of the config fingerprint.
    local -a args=(
        -m "$LLAMA_P_MODEL"
        -ngl "$LLAMA_P_NGL"
        -c "$LLAMA_P_CTX"       # total context; slots split it unless kv_unified
        -t "$LLAMA_P_THREADS"
        --cache-type-k "$LLAMA_P_CACHE_K"
        --cache-type-v "$LLAMA_P_CACHE_V"
        -b "$LLAMA_P_BATCH"
        --ubatch-size "$LLAMA_P_UBATCH"
        --jinja
        --metrics
        --parallel "$LLAMA_P_PARALLEL"
        -lv "${LLAMA_LOG_VERBOSITY:-4}"
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
    [[ -n "$LLAMA_P_OT"  ]] && args+=(-ot "$LLAMA_P_OT")
    [[ ${#LLAMA_P_SPEC[@]}     -gt 0 ]] && args+=("${LLAMA_P_SPEC[@]}")
    [[ ${#LLAMA_P_SAMPLERS[@]} -gt 0 ]] && args+=("${LLAMA_P_SAMPLERS[@]}")
    [[ ${#LLAMA_P_EXTRA[@]}    -gt 0 ]] && args+=("${LLAMA_P_EXTRA[@]}")

    echo "lllm-serve: profile=$LLAMA_P_NAME arch=$LLAMA_P_ARCH ngl=$LLAMA_P_NGL${LLAMA_P_MOE:+ moe=$LLAMA_P_MOE}${LLAMA_P_OT:+ ot=$LLAMA_P_OT} ctx=$LLAMA_P_CTX threads=$LLAMA_P_THREADS parallel=$LLAMA_P_PARALLEL port=$LLAMA_PORT${LLAMA_P_SPEC:+ spec=\"${LLAMA_P_SPEC[*]}\"}" >&2

    if [[ "$LLAMA_P_ARCH" == "dense" && "$LLAMA_P_NGL" != "99" ]]; then
        echo "lllm-serve: dense model, partial offload. Watch 'n_layer' in the load" >&2
        echo "            log and confirm VRAM headroom with lllm-vram before" >&2
        echo "            treating -ngl as tuned." >&2
    fi

    # GPU telemetry for the life of this server. The recorder waits for the port,
    # samples until it is killed below, and appends the run to logs/. If Ctrl-C
    # aborts this function before the cleanup runs, it stops on its own once the
    # port stops answering. Set LLAMA_VRAM_LOG=0 to skip it.
    local vram_pid="" serverlog=""
    if [[ "${LLAMA_VRAM_LOG:-1}" != "0" ]] && command -v nvidia-smi >/dev/null 2>&1; then
        local here logdir
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [[ -f "$here/vram-log.sh" ]]; then
            # $LLAMA_REPO/logs directly, not a path relative to this file's own
            # directory: this file lives two levels down (scripts/shell/), so a
            # relative "$here/.." no longer lands on the repo root the way it did
            # when this was scripts/llama-env.sh. LLAMA_REPO is already resolved
            # correctly above regardless of how deep this file lives.
            logdir="${LLAMA_VRAM_LOGDIR:-$LLAMA_REPO/logs}"
            mkdir -p "$logdir"
            # llama-server's own load log, kept for the recorder to parse: the
            # layer split it actually chose, n_layer, fused-kernel resolution and
            # deprecation warnings are known only to the server. Removed below,
            # once the recorder has finished with it.
            serverlog="$logdir/.server.$$.log"
            LLAMA_SERVER_LOG="$serverlog" \
                bash "$here/vram-log.sh" record "$LLAMA_P_NAME" &
            vram_pid=$!
        fi
    fi

    local rc
    if [[ -n "$serverlog" ]]; then
        # The file gets everything; the terminal copy drops the GGUF metadata
        # dump, which -lv 4 turns into ~60 lines of key/value listing.
        "$LLAMA_BIN/llama-server" "${args[@]}" "$@" 2>&1 \
            | tee "$serverlog" \
            | grep -v --line-buffered 'llama_model_loader: - ' >&2
        rc=${PIPESTATUS[0]}
    else
        "$LLAMA_BIN/llama-server" "${args[@]}" "$@"
        rc=$?
    fi

    if [[ -n "$vram_pid" ]]; then
        kill -TERM "$vram_pid" 2>/dev/null
        wait "$vram_pid" 2>/dev/null
    fi
    # After the recorder has read it, not before: it is the recorder's input.
    [[ -n "$serverlog" ]] && rm -f "$serverlog"

    return $rc
}

# ---------------------------------------------------------------------------
# The two sweeps below drive llama-bench, not llama-server. They write nothing
# to logs/llama.db, so their numbers are not comparable with a served run and do
# not survive the terminal; they are pre-flight, for getting into the right
# neighbourhood before serving anything. `lllm-tune` supersedes them for
# choosing a serving configuration: it searches over served runs, records every
# request, and judges correctness alongside throughput.
#
# They are kept rather than folded into lllm-tune because llama-bench retains
# GPU allocations across reloads on WSL2 (see the note in lllm-sweep-ngl), so
# reusing them as a feasibility pre-screen would import that defect into the
# search.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# lllm-sweep-threads: generation throughput across thread counts
#
# Worth re-running for the dense profile. The earlier finding that throughput
# plateaus above four threads was measured on a 3B-active MoE, which is almost
# purely bandwidth-bound. A dense 27B does roughly nine times the arithmetic per
# token, so the compute-versus-bandwidth balance shifts and the curve may differ.
# ---------------------------------------------------------------------------
lllm-sweep-threads() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != *,* && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _lllm_profile "$profile" || return 1

    local threads="${1:-4,6,8,10}"

    local -a args=(-m "$LLAMA_P_MODEL" -t "$threads" -ngl "$LLAMA_P_NGL" -o md)
    [[ -n "$LLAMA_P_MOE" ]] && args+=(--n-cpu-moe "$LLAMA_P_MOE")

    echo "lllm-sweep-threads: profile=$LLAMA_P_NAME threads=$threads" >&2
    "$LLAMA_BIN/llama-bench" "${args[@]}"
}

# ---------------------------------------------------------------------------
# lllm-sweep-ngl: find the GPU layer count that fills VRAM without spilling
#
# This is the dense-model equivalent of tuning --n-cpu-moe. Start low, walk up,
# and take the highest value that does not fail to allocate or start swapping.
# ---------------------------------------------------------------------------
lllm-sweep-ngl() {
    local profile="$LLAMA_DEFAULT_PROFILE"
    if [[ $# -gt 0 && "$1" != *,* && "$1" != -* ]]; then
        profile="$1"; shift
    fi
    _lllm_profile "$profile" || return 1

    if [[ "$LLAMA_P_ARCH" == "moe" ]]; then
        echo "lllm-sweep-ngl: '$LLAMA_P_NAME' is MoE; sweep --n-cpu-moe instead:" >&2
        echo "  $LLAMA_BIN/llama-bench -m \"$LLAMA_P_MODEL\" -ngl 99 --n-cpu-moe 30,32,34,36 -o md" >&2
        return 1
    fi

    local ngl="${1:-12,16,20,24}"
    local -a vals; local v
    IFS=',' read -ra vals <<< "$ngl"

    # One process per value. llama-bench retains GPU allocations across model
    # reloads, so on WSL2 every configuration after the first is contaminated
    # once any value spills into system memory.
    # -ot is passed through so the sweep measures the same tensor placement
    # lllm-serve uses; without it the VRAM headroom found here is not the
    # headroom the server will see.
    local -a ot=()
    [[ -n "$LLAMA_P_OT" ]] && ot=(-ot "$LLAMA_P_OT")

    for v in "${vals[@]}"; do
        echo "--- ngl=$v (fresh process) ---" >&2
        "$LLAMA_BIN/llama-bench" \
            -m "$LLAMA_P_MODEL" \
            -ngl "$v" \
            "${ot[@]}" \
            -t "$LLAMA_P_THREADS" \
            -p 512 -n 128 \
            -o md
        sleep 3
    done
}

# ---------------------------------------------------------------------------
# _lllm_python: the interpreter the local-llm Python tooling runs under
#
# This box's python3 is externally managed (PEP 668), so `pip install` refuses
# outright and a venv is required rather than merely tidy. The venv is created
# on first use when the shell is interactive; a non-interactive caller gets bare
# python3 and the plain-text output path instead of an unexpected 200 MB
# download. LLAMA_NO_BOOTSTRAP=1 disables creation entirely.
#
# NOTE: scripts/shell/vram-log.sh deliberately does NOT go through this. The
# telemetry recorder now writes to the Open WebUI fork's own Postgres (see
# open_webui.benchmarks.telemetry_recorder) and so runs under that fork's
# backend venv (_lllm_openwebui_python below), not this one -- the recorder
# stopped being stdlib-only when its store did, but it still runs as a
# separate subprocess from either venv's own caller, for the same
# crash-independence reason it always has.
#
# Kept entirely separate from _lllm_openwebui_python below: the Open WebUI
# fork's backend pulls in torch, sentence-transformers and faster-whisper,
# which have no business anywhere near this stdlib-light venv.
# ---------------------------------------------------------------------------
_lllm_python() {
    local venv="$LLAMA_REPO/.venv/bin/python"
    if [[ -x "$venv" ]]; then
        printf '%s' "$venv"; return 0
    fi
    if [[ "${LLAMA_NO_BOOTSTRAP:-0}" != "1" && $- == *i* && -t 2 ]]; then
        echo "lllm: creating $LLAMA_REPO/.venv (first run; needs rich, textual," \
             "numpy, pandas)" >&2
        if python3 -m venv "$LLAMA_REPO/.venv" >&2 \
           && "$venv" -m pip install -q --upgrade pip >&2 \
           && "$venv" -m pip install -q -r "$LLAMA_REPO/requirements.txt" >&2; then
            printf '%s' "$venv"; return 0
        fi
        echo "lllm: venv setup failed; falling back to python3 (plain output," \
             "and DS-1000 grading will be unavailable)" >&2
    fi
    printf '%s' "$(command -v python3)"
}

# ---------------------------------------------------------------------------
# lllm-test was retired here: benchmark running/grading/comparison now lives
# in the Open WebUI fork's own "Benchmarks" section (Tests/Compare/Answers
# pages), backed by this app's Postgres instead of logs/llama.db. See
# docs/CLAUDE.md's decisions log. The adapter/suite TOMLs and system-prompt
# text files moved with it, into
# open-web-ui/openwebui/backend/open_webui/benchmarks/data/ -- they no
# longer live at tests/adapters, tests/suites or prompts/system here.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# lllm-web was retired here: its seven pages (Serve/Live/Tests/Compare/
# Answers/Report/Tune) now live in the Open WebUI fork itself, at
# /benchmarks in lllm-frontend, served by lllm-backend -- the merge this
# comment used to call "a deferred, separate piece of work" is the work this
# migration is. There is no more standalone dashboard port; use
# lllm-frontend/lllm-backend.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# _lllm_openwebui_python: the interpreter the Open WebUI fork's backend runs
# under
#
# A dedicated venv at open-web-ui/openwebui/backend/.venv, bootstrapped on
# first use exactly like _lllm_python bootstraps the shared one -- kept
# completely separate on purpose (see the comment on _lllm_python above).
# ---------------------------------------------------------------------------
_lllm_openwebui_python() {
    local dir="$LLAMA_REPO/open-web-ui/openwebui/backend"
    local venv="$dir/.venv/bin/python"
    if [[ -x "$venv" ]]; then
        printf '%s' "$venv"; return 0
    fi
    echo "lllm: creating $dir/.venv (first run; installs the Open WebUI" \
         "fork's backend requirements)" >&2
    python3 -m venv "$dir/.venv" >&2
    "$venv" -m pip install -q --upgrade pip >&2
    "$venv" -m pip install -q -r "$dir/requirements.txt" >&2
    printf '%s' "$venv"
}

# ---------------------------------------------------------------------------
# lllm-frontend: the Open WebUI fork's frontend, in dev mode
#
#   lllm-frontend                  # vite dev server on :5173
#
# Proxies API/WS calls to lllm-backend via WEBUI_BACKEND_URL (read by the
# fork's vite.config.ts; defaults to :8080 upstream, which is reserved on
# this host for other tooling -- see LLAMA_PORT above -- so it is pointed at
# :4000, where lllm-backend actually listens).
#
# Uses bun, not npm: nothing in the fork requires npm specifically (Vite/
# SvelteKit tooling is package-manager agnostic), but be aware this is
# genuinely untested upstream -- Open WebUI's own dev docs and package.json's
# engines field only reference Node.js/npm. If the build ever misbehaves in a
# way that's hard to explain, `cd open-web-ui/openwebui && npm ci && npm run
# dev` is the documented, CI/Docker-tested fallback to try first.
# ---------------------------------------------------------------------------
lllm-frontend() (
    cd "$LLAMA_REPO/open-web-ui/openwebui" || exit 1
    [[ -d node_modules ]] || bun install
    WEBUI_BACKEND_URL="http://localhost:${LLLM_BACKEND_PORT:-4000}" bun run dev
)

# ---------------------------------------------------------------------------
# lllm-backend: the Open WebUI fork's backend, in dev mode -- plus the
# Postgres+pgvector container it depends on
#
#   lllm-backend                   # uvicorn --reload on :4000, Postgres via
#                                   # open-web-ui/docker-compose.yml
#
# Starts Postgres before the backend and tears it down when the backend
# stops (Ctrl-C included) via the trap below. Run as a subshell `(...)`,
# not a plain function body: a `trap ... EXIT` set directly in a sourced
# function attaches to the caller's *interactive shell*, and would tear
# Postgres down on every future shell exit, not just when this command's
# uvicorn process stops. The parens give the trap its own, correctly-scoped
# lifetime.
#
# DATABASE_URL/VECTOR_DB/WEBUI_SECRET_KEY/OPENAI_* need POSTGRES_PASSWORD,
# WEBUI_SECRET_KEY and OPENROUTER_API_KEY, which this function loads itself
# from open-web-ui/.env -- it does not rely on the caller having sourced
# anything first. Without WEBUI_SECRET_KEY set, the app exits immediately on
# import (env.py's own hard-requirement check), and under --reload the
# supervisor just respawns the dying worker in a tight loop rather than
# failing loudly -- a real failure mode this hit once, hence loading the env
# file explicitly here instead of documenting it as the caller's job.
# ---------------------------------------------------------------------------
lllm-backend() (
    trap 'docker compose -f "$LLAMA_REPO/open-web-ui/docker-compose.yml" down' EXIT

    local envfile="$LLAMA_REPO/open-web-ui/.env"
    if [[ ! -f "$envfile" ]]; then
        echo "lllm-backend: $envfile not found -- create it with OPENROUTER_API_KEY, POSTGRES_PASSWORD, WEBUI_SECRET_KEY" >&2
        exit 1
    fi
    set -a
    # shellcheck source=/dev/null
    source "$envfile"
    set +a

    docker compose -f "$LLAMA_REPO/open-web-ui/docker-compose.yml" up -d postgres

    local py; py="$(_lllm_openwebui_python)"
    cd "$LLAMA_REPO/open-web-ui/openwebui/backend" || exit 1

    # POSTGRES_PASSWORD is interpolated straight into a URL, so it must be
    # percent-encoded first -- an unescaped '/' or '+' (this repo's own
    # generated passwords use both) otherwise produces a DATABASE_URL that
    # SQLAlchemy/asyncpg happen to parse leniently but psycopg's stricter
    # conninfo parser does not, which silently crashed the telemetry
    # recorder (a separate `python -m ...telemetry_recorder` process that
    # inherits this same env) on every serve/tune run with "failed to
    # resolve host 'openwebui'" -- the database *name*, mistaken for the
    # host once the unescaped password broke the URL's structure.
    local db_password; db_password="$(jq -rn --arg v "$POSTGRES_PASSWORD" '$v|@uri')"

    CORS_ALLOW_ORIGIN="http://localhost:5173" \
    WEBUI_SECRET_KEY="$WEBUI_SECRET_KEY" \
    DATABASE_URL="postgresql://openwebui:${db_password}@localhost:5432/openwebui" \
    VECTOR_DB=pgvector \
    OPENAI_API_BASE_URL="https://openrouter.ai/api/v1" \
    OPENAI_API_KEY="$OPENROUTER_API_KEY" \
    HF_HUB_OFFLINE=1 \
    LLAMA_ENV_SH="$LLAMA_REPO/scripts/shell/main.sh" \
    "$py" -m uvicorn open_webui.main:app --host 0.0.0.0 \
        --port "${LLLM_BACKEND_PORT:-4000}" --reload
    # No `exec` on the line above, deliberately: exec would replace this
    # subshell's process image *and its trap* with uvicorn, so Ctrl-C would
    # kill uvicorn without ever running the docker compose down. Running it
    # as a normal foreground command lets control return here when it
    # exits, so the subshell reaches its end and the EXIT trap fires.
)

# ---------------------------------------------------------------------------
# lllm-report was retired here: the same design-audited statistical report
# (Wilson intervals, Cochran's Q, exact McNemar, power/MDE) is now generated
# from the fork's Report page at /benchmarks/report, reading this app's
# Postgres instead of logs/llama.db. See docs/CLAUDE.md's decisions log.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# lllm-db was retired here along with logs/llama.db itself: the measurement
# store is now the Open WebUI fork's own Postgres (the benchmark_* tables),
# queried through `psql`/a normal Postgres client, not a bespoke wrapper.
# The historical rows this sqlite file held were backfilled in before it was
# retired; see docs/CLAUDE.md's decisions log.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# lllm-profile-names: the defined profiles, one per line
#
# llama_console.py (lllm-profiles) and the Open WebUI fork's
# benchmarks/env_profile.py both call this rather than carrying their own
# copy of the list, so a new profile appears in lllm-profiles and in the
# Benchmarks Serve page's picker without editing either.
# ---------------------------------------------------------------------------
lllm-profile-names() {
    printf '%s\n' "${LLAMA_PROFILE_NAMES[@]}"
}

# ---------------------------------------------------------------------------
# lllm-profile-json: a profile's resolved settings, as JSON
#
# Exists so the Python tooling can read the serving configuration without
# re-declaring the profile table. scripts/shell/main.sh is the single source of
# truth for serving configuration (CLAUDE.md); a second copy in Python would
# disagree with this one the first time either changed.
#
# Every key is exactly `LLAMA_<KNOB>` lowercased with the prefix dropped, because
# llama_web_routes.py maps a form field back to an override variable by that
# transform; a key spelled any other way makes the dashboard report the field as
# overridden on every run.
# ---------------------------------------------------------------------------
lllm-profile-json() {
    _lllm_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1
    local spec extra samplers
    # Empty for a profile that takes no thinking budget, the same test
    # _vramlog_config in vram-log.sh makes before recording "n/a". A
    # non-thinking model reported as reasoning "medium" would have a caller
    # setting LLAMA_REASONING for a server that ignores it.
    local reasoning=""
    [[ "${LLAMA_P_EXTRA[*]:-}" == *reasoning_effort* ]] && reasoning="${LLAMA_REASONING:-medium}"
    # Same resolution _vramlog_config makes, so the key and the fingerprint's
    # `fa:` field cannot disagree about which spelling this build takes.
    local fa="$LLAMA_FA"
    [[ "$LLAMA_FA_LEGACY" == "1" ]] && fa="legacy --flash-attn 1"
    spec="$(printf '%s\n' "${LLAMA_P_SPEC[@]:-}" | jq -R . | jq -sc 'map(select(. != ""))')"
    extra="$(printf '%s\n' "${LLAMA_P_EXTRA[@]:-}" | jq -R . | jq -sc 'map(select(. != ""))')"
    samplers="$(printf '%s\n' "${LLAMA_P_SAMPLERS[@]:-}" | jq -R . | jq -sc 'map(select(. != ""))')"
    jq -nc \
        --arg name "$LLAMA_P_NAME" --arg arch "$LLAMA_P_ARCH" \
        --arg model "$LLAMA_P_MODEL" --arg alias "$LLAMA_P_ALIAS" \
        --arg ot "$LLAMA_P_OT" --arg port "$LLAMA_PORT" \
        --arg ctx "$LLAMA_P_CTX" --arg threads "$LLAMA_P_THREADS" \
        --arg ngl "$LLAMA_P_NGL" --arg moe "$LLAMA_P_MOE" \
        --arg parallel "${LLAMA_P_PARALLEL:-1}" \
        --arg cache_k "${LLAMA_P_CACHE_K:-q8_0}" \
        --arg cache_v "${LLAMA_P_CACHE_V:-q8_0}" \
        --arg batch "${LLAMA_P_BATCH:-512}" \
        --arg ubatch "${LLAMA_P_UBATCH:-512}" \
        --arg fa "$fa" \
        --arg reasoning "$reasoning" \
        --argjson spec "$spec" --argjson extra "$extra" \
        --argjson samplers "$samplers" \
        '{name: $name, arch: $arch, model: $model, alias: $alias,
          port: ($port | tonumber), ctx: $ctx, threads: $threads, ngl: $ngl,
          moe: $moe, parallel: $parallel, ot: $ot, reasoning: $reasoning,
          cache_k: $cache_k, cache_v: $cache_v, batch: $batch,
          ubatch: $ubatch, fa: $fa,
          spec: $spec, extra: $extra, samplers: $samplers,
          weights_present: ($model | length > 0)}' \
    | jq -c --argjson present "$([[ -f "$LLAMA_P_MODEL" ]] && echo true || echo false)" \
        '.weights_present = $present'
}

# ---------------------------------------------------------------------------
# lllm-config-id: the fingerprint a set of overrides would produce
#
#   lllm-config-id qwen36
#   LLAMA_MOE=30 LLAMA_THREADS=8 lllm-config-id qwen36
#
# Prints {"config_id": "...", "alias": "...", "lines": [...]} -- the same six
# lines _vramlog_config records with a run, and the same sha1 over them, without
# starting a server.
#
# It exists for lllm-tune, which has to know whether two candidates are the
# same configuration before it spends an hour measuring both. The alternative
# was reimplementing the fingerprint in Python, which would have put a second
# copy of it beside the one in vram-log.sh and guaranteed they eventually
# disagreed -- and a fingerprint that disagrees with itself files two different
# configurations under one id.
#
# The sourcing runs in a subshell because vram-log.sh sources this file:
# pulling it into the current shell would redefine every function here while one
# of them is running.
# ---------------------------------------------------------------------------
lllm-config-id() {
    local dir; dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    (
        # shellcheck source=./vram-log.sh
        source "$dir/vram-log.sh"
        _lllm_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || exit 1
        _vramlog_config
        printf '%s\n' "${VRAMLOG_CFG_LINES[@]}" \
            | jq -R . \
            | jq -sc --arg id "$VRAMLOG_CFG_ID" --arg alias "$LLAMA_P_ALIAS" \
                  '{config_id: $id, alias: $alias, lines: .}'
    )
}

# ---------------------------------------------------------------------------
# lllm-tune was retired here: the same round-elimination search (staged
# explore/refine, paired throughput ranking, a correctness check against the
# incumbent before adoption, GPU-cooldown/drift handling) now runs from the
# fork's Tune page at /benchmarks/tune, as an in-process async sweep rather
# than a CLI subprocess. It still drives `lllm-serve` under LLAMA_* overrides
# and still reads `lllm-config-id` to fingerprint a candidate before serving
# it -- only the orchestration and the store moved. See docs/CLAUDE.md's
# decisions log.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
lllm-check() {
    local py; py="$(_lllm_python 2>/dev/null)"
    if [[ -n "$py" && -f "$LLAMA_REPO/scripts/llama_console.py" ]]; then
        "$py" "$LLAMA_REPO/scripts/llama_console.py" check
        return $?
    fi
    curl -fsS "http://localhost:${LLAMA_PORT}/v1/models" \
        || { echo "lllm-check: no server responding on port $LLAMA_PORT" >&2; return 1; }
    echo
}

lllm-vram() {
    local py; py="$(_lllm_python 2>/dev/null)"
    if [[ -n "$py" && -f "$LLAMA_REPO/scripts/llama_console.py" ]]; then
        "$py" "$LLAMA_REPO/scripts/llama_console.py" vram
        return $?
    fi
    watch -n 1 nvidia-smi \
        --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.sm \
        --format=csv
}

# ---------------------------------------------------------------------------
# Direct-invocation dispatch. Sourcing this file defines the functions above and
# stops here; executing it runs a subcommand.
#
# The depth check is load-bearing, not belt-and-braces. lllm-config-id sources
# vram-log.sh, which sources this file back, and on that path BASH_SOURCE[0]
# and $0 are both the absolute path of this script and therefore equal -- so
# the nested source re-entered the dispatch with the *function's* positional
# parameters and exited 2 with the usage text. A file being sourced always has
# something above it on the source stack; the top-level program never does.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "$0" && "${#BASH_SOURCE[@]}" -eq 1 ]]; then
    cmd="${1:-serve}"; shift 2>/dev/null || true
    case "$cmd" in
        serve)          lllm-serve "$@" ;;
        fetch)          lllm-fetch "$@" ;;
        sweep-threads)  lllm-sweep-threads "$@" ;;
        sweep-ngl)      lllm-sweep-ngl "$@" ;;
        frontend)       lllm-frontend "$@" ;;
        backend)        lllm-backend "$@" ;;
        check)          lllm-check "$@" ;;
        vram)           lllm-vram "$@" ;;
        vram-log)       "$(dirname "${BASH_SOURCE[0]}")/vram-log.sh" record "$@" ;;
        profiles)       lllm-profiles "$@" ;;
        profile-json)   lllm-profile-json "$@" ;;
        profile-names)  lllm-profile-names "$@" ;;
        config-id)      lllm-config-id "$@" ;;
        *)
            echo "usage: $(basename "$0") {serve|fetch|frontend|backend|sweep-threads|sweep-ngl|check|vram|vram-log|profiles|profile-json|profile-names|config-id} [profile] [args]" >&2
            exit 2
            ;;
    esac
fi
