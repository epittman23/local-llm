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
#   llama-test  [prompt] [profile]
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
: "${LLAMA_DEFAULT_PROFILE:=qwen38}"
: "${LLAMA_PROMPTS:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prompts}"

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
    LLAMA_P_NGL=""; LLAMA_P_MOE=""; LLAMA_P_OT=""
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
            # rejected drafts cost real compute on a CPU-bound model. One server
            # slot because drafting and batched slots contend for the same GPU.
            LLAMA_P_SPEC=(--spec-type draft-mtp --spec-draft-n-max 2 --parallel 1)
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
    [[ -n "${LLAMA_OT:-}"      ]] && LLAMA_P_OT="$LLAMA_OT"
    # LLAMA_SPEC replaces the profile's speculative-decoding flags wholesale;
    # LLAMA_SPEC=off turns them off, which is the A/B this exists for.
    if [[ -n "${LLAMA_SPEC+x}" ]]; then
        if [[ -z "$LLAMA_SPEC" || "$LLAMA_SPEC" == "off" ]]; then
            LLAMA_P_SPEC=()
        else
            read -ra LLAMA_P_SPEC <<< "$LLAMA_SPEC"
        fi
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
    # --metrics exposes /metrics, which llama-vram-log.sh scrapes for the run's
    # server-wide token totals; it is not part of the config fingerprint because
    # it does not change how inference runs.
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
        --metrics
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

    echo "llama-serve: profile=$LLAMA_P_NAME arch=$LLAMA_P_ARCH ngl=$LLAMA_P_NGL${LLAMA_P_MOE:+ moe=$LLAMA_P_MOE}${LLAMA_P_OT:+ ot=$LLAMA_P_OT} ctx=$LLAMA_P_CTX threads=$LLAMA_P_THREADS port=$LLAMA_PORT${LLAMA_P_SPEC:+ spec=\"${LLAMA_P_SPEC[*]}\"}" >&2

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
# llama-test: send a saved prompt to the running server and print the answer
# alongside llama.cpp's own timings
#
#   llama-test                       # default prompt, default profile
#   llama-test humaneval0            # named prompt from prompts/
#   llama-test humaneval0 qwen36     # another profile's sampling/effort
#   llama-test --list                # what prompts exist
#
# The model name comes from the running server (GET /v1/models), not from the
# profile: the profile describes how a model would be served, but the server is
# already serving something, and mislabelling a measurement makes it worthless.
# The profile still supplies reasoning_effort and the prompt's sampling context.
#
# Prompts are files in $LLAMA_PROMPTS (default <repo>/prompts) so a comparison
# run is reproducible: the prompt is version-controlled, not retyped. temperature
# is pinned to 0 for the same reason.
#
# The response is streamed, because at a few tokens per second a blocking call
# looks indistinguishable from a hung server. The answer goes to stdout and the
# model's thinking to stderr, so `llama-test > answer.md` still captures only
# the completion while the reasoning stays watchable on the terminal.
# LLAMA_TEST_STREAM=0 falls back to one blocking request; LLAMA_TEST_RAW=1 keeps
# the raw response instead of deleting it.
# ---------------------------------------------------------------------------
llama-test() {
    if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
        _llama_test_prompts
        return 0
    fi

    local prompt="humaneval0" profile="$LLAMA_DEFAULT_PROFILE"
    [[ $# -gt 0 && "$1" != -* ]] && { prompt="$1"; shift; }
    [[ $# -gt 0 && "$1" != -* ]] && { profile="$1"; shift; }
    _llama_profile "$profile" || return 1

    local c
    for c in curl jq; do
        command -v "$c" >/dev/null 2>&1 || {
            echo "llama-test: '$c' not found" >&2; return 1; }
    done

    local file="$LLAMA_PROMPTS/$prompt.txt"
    if [[ ! -f "$file" ]]; then
        echo "llama-test: no prompt '$prompt' in $LLAMA_PROMPTS" >&2
        _llama_test_prompts >&2
        return 1
    fi

    # The profile only says which model *would* be served; the server serves
    # whatever llama-serve last loaded, which is what actually answers. Ask it,
    # and fall back to the profile alias only when it cannot be reached.
    local model="$LLAMA_P_ALIAS" served
    served="$(curl -sS --connect-timeout 5 \
        "http://localhost:${LLAMA_PORT}/v1/models" 2>/dev/null \
        | jq -r '.data[0].id // empty' 2>/dev/null)"
    if [[ -n "$served" ]]; then
        if [[ "$served" != "$LLAMA_P_ALIAS" ]]; then
            echo "llama-test: port $LLAMA_PORT is serving '$served', not profile" \
                 "$LLAMA_P_NAME's '$LLAMA_P_ALIAS' - testing what is running" >&2
        fi
        model="$served"
    fi

    # Only profiles that actually serve reasoning_effort get the field; sending
    # it to a model whose template ignores it would silently mean nothing.
    local effort=""
    [[ "${LLAMA_P_EXTRA[*]:-}" == *reasoning_effort* ]] && effort="${LLAMA_REASONING:-medium}"

    local req resp
    req="$(mktemp "${TMPDIR:-/tmp}/llama-test-req.XXXXXX.json")"
    resp="$(mktemp "${TMPDIR:-/tmp}/llama-test-resp.XXXXXX.json")"

    local stream="true"
    [[ "${LLAMA_TEST_STREAM:-1}" == "0" ]] && stream="false"

    jq -Rs --arg model "$model" \
           --arg effort "$effort" \
           --argjson max "${LLAMA_TEST_MAX_TOKENS:-2048}" \
           --argjson stream "$stream" '
        {
            model: $model,
            messages: [{role: "user", content: .}],
            max_tokens: $max,
            temperature: 0
        }
        + (if $effort == "" then {}
           else {chat_template_kwargs: {reasoning_effort: $effort}} end)
        + (if $stream then {stream: true} else {} end)
    ' "$file" > "$req" || { rm -f "$req" "$resp"; return 1; }

    echo "llama-test: prompt=$prompt model=$model${effort:+ effort=$effort} port=$LLAMA_PORT stream=$stream" >&2

    # A short connect timeout so a stopped server fails immediately, while the
    # overall timeout stays generous: a thinking model at ~7 t/s is slow.
    local -a curl_args=(
        -sS --connect-timeout 5 --max-time "${LLAMA_TEST_TIMEOUT:-900}"
        "http://localhost:${LLAMA_PORT}/v1/chat/completions"
        -H 'Content-Type: application/json'
        -d @"$req"
    )

    # Wall clock around the request. prompt_ms + predicted_ms is the server's
    # accounting; this is what the caller actually waited, and on a streamed
    # response the two differ.
    local t0 wall timings=""
    t0=$(date +%s%3N)

    if [[ "$stream" == "true" ]]; then
        # -N disables curl's output buffering; without it the whole point of
        # streaming is lost. The raw SSE stream is tee'd aside so the timings in
        # the final chunk survive the loop.
        local rc
        curl -N "${curl_args[@]}" | tee "$resp" | _llama_test_stream
        # The pipeline's exit status is the renderer's, so ask curl directly.
        rc=${PIPESTATUS[0]}
        wall=$(( $(date +%s%3N) - t0 ))
        if (( rc != 0 )); then
            echo "llama-test: no response from port $LLAMA_PORT (is llama-serve running?)" >&2
            rm -f "$req" "$resp"
            return 1
        fi

        if ! grep -q '^data: ' "$resp"; then
            echo "llama-test: unexpected response:" >&2
            cat "$resp" >&2
            rm -f "$req" "$resp"
            return 1
        fi

        # Generation and prompt-processing rates straight from the server, so a
        # profile change can be judged without a separate llama-bench run. In a
        # streamed response they ride on the last chunk.
        echo
        timings="$(sed -n 's/^data: //p' "$resp" | grep -v '^\[DONE\]$' \
            | jq -s 'map(select(has("timings"))) | last | .timings // empty')"
        [[ -n "$timings" ]] && echo "$timings"
    else
        curl "${curl_args[@]}" > "$resp"
        local rc=$?
        wall=$(( $(date +%s%3N) - t0 ))
        if (( rc != 0 )); then
            echo "llama-test: no response from port $LLAMA_PORT (is llama-serve running?)" >&2
            rm -f "$req" "$resp"
            return 1
        fi

        if ! jq -e '.choices[0].message' "$resp" >/dev/null 2>&1; then
            echo "llama-test: unexpected response:" >&2
            cat "$resp" >&2
            rm -f "$req" "$resp"
            return 1
        fi

        jq -r '.choices[0].message.content' "$resp"
        echo
        timings="$(jq '.timings // empty' "$resp")"
        [[ -n "$timings" ]] && echo "$timings"
    fi

    _llama_test_record "$timings" "$model" "$prompt" "$wall"

    if [[ "${LLAMA_TEST_RAW:-0}" == "1" ]]; then
        echo "llama-test: full response kept at $resp" >&2
        rm -f "$req"
    else
        rm -f "$req" "$resp"
    fi
}

# Hand this request's timings to the run llama-vram-log.sh is recording, so the
# numbers outlive the terminal. llama_log.py does nothing when no run is active,
# which is the right outcome for a server someone started by hand.
_llama_test_record() {
    local timings="$1" model="$2" prompt="$3" wall="$4"
    [[ -n "$timings" && "$timings" != "null" ]] || return 0
    command -v python3 >/dev/null 2>&1 || return 0

    local here logdir
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    [[ -f "$here/llama_log.py" ]] || return 0
    logdir="${LLAMA_VRAM_LOGDIR:-$(cd "$here/.." && pwd)/logs}"

    printf '%s' "$timings" | python3 "$here/llama_log.py" request \
        --logdir "$logdir" --model "$model" --prompt "$prompt" \
        --port "$LLAMA_PORT" --wall-ms "${wall:-0}" \
        --timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null
}

# Render an OpenAI-style SSE stream: answer to stdout, thinking to stderr.
# jq writes to the terminal directly rather than through a command substitution,
# which would strip the trailing newlines that matter in a code answer.
_llama_test_stream() {
    local line json kind thinking="" answering=""
    while IFS= read -r line; do
        [[ "$line" == data:\ * ]] || continue
        json="${line#data: }"
        [[ "$json" == "[DONE]" ]] && break

        # One jq classifies the chunk, a second prints its text. Classifying in
        # jq rather than pattern-matching the raw JSON keeps a completion that
        # merely mentions "reasoning_content" from being mistaken for thinking.
        kind="$(jq -r '[(if .choices[0].delta.reasoning_content != null
                         then "r" else empty end),
                        (if .choices[0].delta.content != null
                         then "c" else empty end)] | join("")' \
                <<< "$json" 2>/dev/null)"

        # Both banners go to stderr, including the one announcing the answer:
        # stdout must stay the completion and nothing else.
        if [[ "$kind" == *r* ]]; then
            [[ -n "$thinking" ]] || { printf '\n--- thinking ---\n' >&2; thinking=1; }
            # Order matters: >&2 must copy the real stderr onto stdout before 2>
            # is pointed at /dev/null, or the thinking goes to /dev/null instead.
            jq -j '.choices[0].delta.reasoning_content // empty' <<< "$json" >&2 2>/dev/null
        fi
        if [[ "$kind" == *c* ]]; then
            [[ -n "$answering" ]] || { printf '\n\n--- response ---\n' >&2; answering=1; }
            jq -j '.choices[0].delta.content // empty' <<< "$json" 2>/dev/null
        fi
    done
    echo
}

_llama_test_prompts() {
    local f
    echo "prompts in $LLAMA_PROMPTS:"
    for f in "$LLAMA_PROMPTS"/*.txt; do
        [[ -f "$f" ]] || { echo "  (none)"; return 0; }
        f="$(basename "$f")"; echo "  ${f%.txt}"
    done
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
        test)           llama-test "$@" ;;
        check)          llama-check "$@" ;;
        vram)           llama-vram "$@" ;;
        vram-log)       "$(dirname "${BASH_SOURCE[0]}")/llama-vram-log.sh" record "$@" ;;
        profiles)       llama-profiles "$@" ;;
        *)
            echo "usage: $(basename "$0") {serve|fetch|test|sweep-threads|sweep-ngl|check|vram|vram-log|profiles} [profile] [args]" >&2
            exit 2
            ;;
    esac
fi