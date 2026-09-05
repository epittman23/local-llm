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
#   llama-test  <benchmark>/<item-id> | --suite smoke|standard|full
#               [--system <name>]            # prompts/system/<name>.txt
#   llama-test  list | fetch | selfcheck | compare | answer | ui
#   llama-ui                                 # the Textual dashboard
#   llama-db    sql | prune | vacuum | export | schema
#   llama-sweep-threads [profile] [thread-list]
#   llama-sweep-ngl     [profile] [ngl-list]
#   llama-fetch         [profile]            # model weights, not test data
#   llama-check
#   llama-vram
#   llama-profiles
#   llama-profile-names
#
# GPU telemetry, request timings and test results all go into one SQLite
# database, logs/llama.db, written by scripts/llama-vram-log.sh (serving) and
# scripts/llama_test.py (tests). Nothing writes a markdown log any more; see
# README.md for the schema and llama-db below for the query entry points.
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
: "${LLAMA_REPO:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Flash attention flag spelling changed in llama.cpp during 2026: older builds
# accept `--flash-attn 1`, current builds accept `-fa on|off|auto`. This script
# uses the current form. If your build predates the change, set LLAMA_FA_LEGACY=1.
: "${LLAMA_FA:=on}"
: "${LLAMA_FA_LEGACY:=0}"

export LLAMA_BIN LLAMA_MODELS LLAMA_HOST LLAMA_PORT LLAMA_REPO

# Every profile _llama_profile knows about, in the order diagnostics list them.
# Declared once here rather than repeated in each place that enumerates them:
# the two Python front ends read it back through `profile-names` below, so
# adding a profile means editing this file and nothing else.
LLAMA_PROFILE_NAMES=(qwen38 qwen36 qwen25c)

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
            # PLACEHOLDER. Tune this with llama-sweep-ngl before trusting it.
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

        qwen25c|qwen2.5-coder|coder)
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
            # LLAMA_CTX and confirm with llama-vram if you need the context more
            # than the margin.
            LLAMA_P_CTX=16384
            LLAMA_P_THREADS=6       # batch assembly only; no layer runs on CPU
            # Qwen2.5-Coder's own generation_config.json, which is not the
            # Qwen3.8 thinking-mode set above. llama-test pins temperature to 0
            # in its request body regardless, so these govern Open WebUI traffic.
            LLAMA_P_SAMPLERS=(--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1)
            # No LLAMA_P_SPEC: Qwen2.5 predates the nextn/MTP tensors qwen38
            # drafts from, and no draft model is worth 4.36 GiB of this card.
            # No LLAMA_P_EXTRA: not a thinking model, so there is no
            # reasoning_effort to set and no reasoning_content in its responses.
            ;;

        *)
            echo "llama: unknown profile '$p'" >&2
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
    # literals in llama-serve so that the flags actually passed and the flags
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
        echo "llama: --parallel does not belong in LLAMA_SPEC; use LLAMA_PARALLEL=N" >&2
        return 1
    fi

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
    local py; py="$(_llama_python 2>/dev/null)"
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
    # --metrics exposes /metrics, which llama-vram-log.sh scrapes for the run's
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

    echo "llama-serve: profile=$LLAMA_P_NAME arch=$LLAMA_P_ARCH ngl=$LLAMA_P_NGL${LLAMA_P_MOE:+ moe=$LLAMA_P_MOE}${LLAMA_P_OT:+ ot=$LLAMA_P_OT} ctx=$LLAMA_P_CTX threads=$LLAMA_P_THREADS parallel=$LLAMA_P_PARALLEL port=$LLAMA_PORT${LLAMA_P_SPEC:+ spec=\"${LLAMA_P_SPEC[*]}\"}" >&2

    if [[ "$LLAMA_P_ARCH" == "dense" && "$LLAMA_P_NGL" != "99" ]]; then
        echo "llama-serve: dense model, partial offload. Watch 'n_layer' in the load" >&2
        echo "             log and confirm VRAM headroom with llama-vram before" >&2
        echo "             treating -ngl as tuned." >&2
    fi

    # GPU telemetry for the life of this server. The recorder waits for the port,
    # samples until it is killed below, and appends the run to logs/. If Ctrl-C
    # aborts this function before the cleanup runs, it stops on its own once the
    # port stops answering. Set LLAMA_VRAM_LOG=0 to skip it.
    local vram_pid="" serverlog=""
    if [[ "${LLAMA_VRAM_LOG:-1}" != "0" ]] && command -v nvidia-smi >/dev/null 2>&1; then
        local here logdir
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [[ -f "$here/llama-vram-log.sh" ]]; then
            logdir="${LLAMA_VRAM_LOGDIR:-$(cd "$here/.." && pwd)/logs}"
            mkdir -p "$logdir"
            # llama-server's own load log, kept for the recorder to parse: the
            # layer split it actually chose, n_layer, fused-kernel resolution and
            # deprecation warnings are known only to the server. Removed below,
            # once the recorder has finished with it.
            serverlog="$logdir/.server.$$.log"
            LLAMA_SERVER_LOG="$serverlog" \
                bash "$here/llama-vram-log.sh" record "$LLAMA_P_NAME" &
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
    local -a vals; local v
    IFS=',' read -ra vals <<< "$ngl"

    # One process per value. llama-bench retains GPU allocations across model
    # reloads, so on WSL2 every configuration after the first is contaminated
    # once any value spills into system memory.
    # -ot is passed through so the sweep measures the same tensor placement
    # llama-serve uses; without it the VRAM headroom found here is not the
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
# _llama_python: the interpreter the Python tooling runs under
#
# This box's python3 is externally managed (PEP 668), so `pip install` refuses
# outright and a venv is required rather than merely tidy. The venv is created
# on first use when the shell is interactive; a non-interactive caller gets bare
# python3 and the plain-text output path instead of an unexpected 200 MB
# download. LLAMA_NO_BOOTSTRAP=1 disables creation entirely.
#
# NOTE: scripts/llama-vram-log.sh deliberately does NOT go through this. The
# telemetry recorder runs in the background for the life of every server and
# must keep working with bare python3, which is why llama_db.py, llama_record.py,
# llama_stats.py, llama_tests.py and llama_results.py are all stdlib-only.
# ---------------------------------------------------------------------------
_llama_python() {
    local venv="$LLAMA_REPO/.venv/bin/python"
    if [[ -x "$venv" ]]; then
        printf '%s' "$venv"; return 0
    fi
    if [[ "${LLAMA_NO_BOOTSTRAP:-0}" != "1" && $- == *i* && -t 2 ]]; then
        echo "llama: creating $LLAMA_REPO/.venv (first run; needs rich, textual," \
             "numpy, pandas)" >&2
        if python3 -m venv "$LLAMA_REPO/.venv" >&2 \
           && "$venv" -m pip install -q --upgrade pip >&2 \
           && "$venv" -m pip install -q -r "$LLAMA_REPO/requirements.txt" >&2; then
            printf '%s' "$venv"; return 0
        fi
        echo "llama: venv setup failed; falling back to python3 (plain output," \
             "and DS-1000 grading will be unavailable)" >&2
    fi
    printf '%s' "$(command -v python3)"
}

# ---------------------------------------------------------------------------
# llama-test: run published benchmark items against the running server, grade
# them with the benchmark's own tests, and record the result
#
#   llama-test humaneval/HumanEval/0     # one item
#   llama-test --suite smoke             # a tier (24 items)
#   llama-test --suite smoke --system assistant   # ... under a system prompt
#   llama-test --suite full --resume     # continue an interrupted run
#   llama-test list                      # benchmarks, tiers, revisions
#   llama-test fetch                     # download the datasets
#   llama-test selfcheck                 # grade the datasets' own answers
#   llama-test compare                   # rank models/configs by pass rate
#   llama-test answer humaneval/HumanEval/0   # print a stored answer
#   llama-test ui                        # the Textual dashboard
#
# The body lives in scripts/llama_test.py; this is a wrapper so the command
# keeps its name and its place beside llama-serve. Everything the bash version
# guaranteed still holds, and for the same reasons:
#
#   * The model name comes from the running server (GET /v1/models), not from
#     the profile. The profile describes how a model would be served; the server
#     is already serving something, and mislabelling a measurement makes it
#     worthless.
#   * temperature is pinned to 0 and cache_prompt defaults to false, so a
#     repeated prompt measures the configuration and not the prefix cache.
#   * The answer goes to stdout and the model's thinking to stderr, so
#     `llama-test humaneval/HumanEval/0 > answer.md` captures the completion
#     alone. Rich output is on stderr only, and only when it is a terminal.
#
# The item prompts are not files in prompts/. They are rendered from the
# datasets' own text through the templates in tests/adapters/*.toml, which is
# what makes a pass rate comparable to a published one. What does live in
# prompts/system/ is the optional *system* prompt --system names: not a test,
# not graded, and carrying no ground truth, just a request variable that gets
# recorded with the result and grouped on by `compare`, so a run made with one
# is never averaged with a run made without. LLAMA_TEST_STREAM=0 restores a
# single blocking request; the other LLAMA_TEST_* variables are unchanged
# (MAX_TOKENS, TIMEOUT, CACHE_PROMPT).
# ---------------------------------------------------------------------------
llama-test() {
    local py; py="$(_llama_python)"
    LLAMA_PORT="$LLAMA_PORT" "$py" "$LLAMA_REPO/scripts/llama_test.py" "$@"
}

# ---------------------------------------------------------------------------
# llama-ui: the Textual dashboard over serving, tests and comparison
#
# Every screen displays the shell command equivalent to its current form state,
# so it teaches the flags rather than hiding them.
# ---------------------------------------------------------------------------
llama-ui() {
    local py; py="$(_llama_python)"
    LLAMA_PORT="$LLAMA_PORT" "$py" "$LLAMA_REPO/scripts/llama_ui.py" "$@"
}

# ---------------------------------------------------------------------------
# llama-report: a statistical report over the measurement store
#
#   llama-report                       # logs/report/<UTC date>/report.md + PNGs
#   llama-report --out /tmp/r          # somewhere else
#   llama-report --stdout              # the document on stdout, so it pipes
#   llama-report --tier smoke --benchmark mbpp     # narrow the scope
#   llama-report --no-figures          # text plots instead of PNGs
#
# This is `llama-test compare` grown a spine. `compare` ranks; it has no way to
# say whether a difference it shows is real, and with a smoke tier at n = 24 the
# gap between two adjacent rows is routinely one item. The report audits the
# design first -- which factors actually varied, what is confounded with what,
# whether the levels of a contrast even ran under the same GPU regime -- and
# refuses a comparison the design cannot support, naming the reason, rather than
# printing a p-value over it. Where the design does support a test it runs the
# paired one, because the tiers are seeded so every configuration draws the same
# items, and a test that ignores the pairing throws away the only thing making
# 8 items informative.
#
# It reads the database and writes nothing back: no migration, no schema_note,
# no row. The markdown is output, as all markdown here has been since the store
# moved to SQLite; nothing reads it.
#
# Needs the venv, and specifically scipy (see requirements-extra.txt); it exits
# 2 with the install line rather than degrading, since a statistics report with
# the statistics removed is not a smaller version of itself. matplotlib is
# optional: without it every figure renders as a unicode plot in a fenced block
# and the document is otherwise identical.
# ---------------------------------------------------------------------------
llama-report() {
    local py; py="$(_llama_python)"
    "$py" "$LLAMA_REPO/scripts/llama_report.py" "$@"
}

# ---------------------------------------------------------------------------
# llama-db: the store itself
#
#   llama-db                 # open the sqlite3 shell on logs/llama.db
#   llama-db sql "SELECT ..."          # one query, as a table
#   llama-db schema                    # .schema
#   llama-db prune --before 2026-08-01 # drop samples and scrapes before a date
#   llama-db vacuum                    # reclaim the space a prune freed
#   llama-db export <dir>              # every table as CSV
#
# Reading is deliberately not wrapped: the whole reason for moving off markdown
# is that the store answers questions nobody wrote a command for, and a menu of
# canned queries would put that back. `llama-db` opens the shell; llama-test
# compare and llama-ui are the two views worth having as commands.
#
# prune is the escape valve for the reversed retention rule (CLAUDE.md,
# 2026-08-30): every GPU sample is now kept, at roughly 1 MB per day of
# continuous serving, so nothing needs pruning for a long time, and when it does
# it should be a decision rather than a silent discard. It touches only the
# telemetry -- results, answers, requests and configurations are never dropped
# by it, because those are the measurements.
# ---------------------------------------------------------------------------
llama-db() {
    local db="${LLAMA_DB:-${LLAMA_VRAM_LOGDIR:-$LLAMA_REPO/logs}/llama.db}"
    local cmd="${1:-shell}"; shift 2>/dev/null || true

    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "llama-db: sqlite3 is not installed" >&2; return 1
    fi
    if [[ ! -f "$db" && "$cmd" != "shell" ]]; then
        echo "llama-db: no database at $db (it is created by llama-serve or llama-test)" >&2
        return 1
    fi

    case "$cmd" in
        shell)  sqlite3 -box "$db" ;;
        sql)    [[ $# -gt 0 ]] || { echo "usage: llama-db sql \"SELECT ...\"" >&2; return 2; }
                sqlite3 -box -header "$db" "$*" ;;
        schema) sqlite3 "$db" ".schema" ;;
        vacuum) sqlite3 "$db" "VACUUM;" && echo "vacuumed $db" ;;
        prune)
            local before=""
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --before) before="$2"; shift 2 ;;
                    *) echo "llama-db prune: unknown argument '$1'" >&2; return 2 ;;
                esac
            done
            [[ -n "$before" ]] || { echo "usage: llama-db prune --before YYYY-MM-DD" >&2; return 2; }
            sqlite3 "$db" <<SQL
DELETE FROM gpu_sample WHERE at < '$before';
DELETE FROM metrics_scrape WHERE at < '$before';
SELECT 'gpu_sample rows left: ' || count(*) FROM gpu_sample;
SELECT 'metrics_scrape rows left: ' || count(*) FROM metrics_scrape;
SQL
            echo "run 'llama-db vacuum' to reclaim the space" ;;
        export)
            local out="${1:-$LLAMA_REPO/logs/export}"
            mkdir -p "$out" || return 1
            local t
            for t in $(sqlite3 "$db" \
                    "SELECT name FROM sqlite_master WHERE type='table' \
                     AND name NOT LIKE 'sqlite_%' ORDER BY name"); do
                sqlite3 -header -csv "$db" "SELECT * FROM $t;" > "$out/$t.csv"
            done
            echo "exported $(ls -1 "$out"/*.csv | wc -l) tables to $out" ;;
        *)
            echo "usage: llama-db {shell|sql|schema|prune|vacuum|export}" >&2
            return 2 ;;
    esac
}

# ---------------------------------------------------------------------------
# llama-profile-names: the defined profiles, one per line
#
# The Python front ends (llama_console.py, llama_ui.py) call this rather than
# carrying their own copy of the list, so a new profile appears in llama-profiles
# and in the dashboard's picker without editing either.
# ---------------------------------------------------------------------------
llama-profile-names() {
    printf '%s\n' "${LLAMA_PROFILE_NAMES[@]}"
}

# ---------------------------------------------------------------------------
# llama-profile-json: a profile's resolved settings, as JSON
#
# Exists so the Python tooling can read the serving configuration without
# re-declaring the profile table. scripts/llama-env.sh is the single source of
# truth for serving configuration (CLAUDE.md); a second copy in Python would
# disagree with this one the first time either changed.
# ---------------------------------------------------------------------------
llama-profile-json() {
    _llama_profile "${1:-$LLAMA_DEFAULT_PROFILE}" || return 1
    local spec extra samplers
    # Empty for a profile that takes no thinking budget, the same test
    # _vramlog_config in llama-vram-log.sh makes before recording "n/a". A
    # non-thinking model reported as reasoning "medium" would have a caller
    # setting LLAMA_REASONING for a server that ignores it.
    local reasoning=""
    [[ "${LLAMA_P_EXTRA[*]:-}" == *reasoning_effort* ]] && reasoning="${LLAMA_REASONING:-medium}"
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
        --arg reasoning "$reasoning" \
        --argjson spec "$spec" --argjson extra "$extra" \
        --argjson samplers "$samplers" \
        '{name: $name, arch: $arch, model: $model, alias: $alias,
          port: ($port | tonumber), ctx: $ctx, threads: $threads, ngl: $ngl,
          moe: $moe, parallel: $parallel, ot: $ot, reasoning: $reasoning,
          spec: $spec, extra: $extra, samplers: $samplers,
          weights_present: ($model | length > 0)}' \
    | jq -c --argjson present "$([[ -f "$LLAMA_P_MODEL" ]] && echo true || echo false)" \
        '.weights_present = $present'
}

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
llama-check() {
    local py; py="$(_llama_python 2>/dev/null)"
    if [[ -n "$py" && -f "$LLAMA_REPO/scripts/llama_console.py" ]]; then
        "$py" "$LLAMA_REPO/scripts/llama_console.py" check
        return $?
    fi
    curl -fsS "http://localhost:${LLAMA_PORT}/v1/models" \
        || { echo "llama-check: no server responding on port $LLAMA_PORT" >&2; return 1; }
    echo
}

llama-vram() {
    local py; py="$(_llama_python 2>/dev/null)"
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
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    cmd="${1:-serve}"; shift 2>/dev/null || true
    case "$cmd" in
        serve)          llama-serve "$@" ;;
        fetch)          llama-fetch "$@" ;;
        sweep-threads)  llama-sweep-threads "$@" ;;
        sweep-ngl)      llama-sweep-ngl "$@" ;;
        test)           llama-test "$@" ;;
        ui)             llama-ui "$@" ;;
        report)         llama-report "$@" ;;
        db)             llama-db "$@" ;;
        check)          llama-check "$@" ;;
        vram)           llama-vram "$@" ;;
        vram-log)       "$(dirname "${BASH_SOURCE[0]}")/llama-vram-log.sh" record "$@" ;;
        profiles)       llama-profiles "$@" ;;
        profile-json)   llama-profile-json "$@" ;;
        profile-names)  llama-profile-names "$@" ;;
        *)
            echo "usage: $(basename "$0") {serve|fetch|test|ui|report|db|sweep-threads|sweep-ngl|check|vram|vram-log|profiles|profile-json|profile-names} [profile] [args]" >&2
            exit 2
            ;;
    esac
fi