#!/usr/bin/env bash
# llama.cpp local inference helpers.
#
# Source this from ~/.bashrc to get the llama-* functions and aliases:
#
#     [ -f "$HOME/dev/repos/home-llm/llama-local.sh" ] && . "$HOME/dev/repos/home-llm/llama-local.sh"
#
# CUDA must be on PATH for the CUDA-enabled llama.cpp build:
#     export PATH=/usr/local/cuda/bin:$PATH
#     export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH

export LLAMA_BIN="${LLAMA_BIN:-$HOME/llama.cpp/build/bin}"
export LLAMA_MODELS="${LLAMA_MODELS:-$HOME/models}"

# Default model: Qwen3.6-35B-A3B (MoE, 34.66B total / ~3B active) at UD-Q4_K_XL.
LLAMA_DEFAULT_MODEL="${LLAMA_DEFAULT_MODEL:-$LLAMA_MODELS/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf}"

# Start llama-server with an OpenAI-compatible API on $LLAMA_PORT (default 8090).
# Overridable via env: LLAMA_MODEL, LLAMA_MOE, LLAMA_CTX, LLAMA_THREADS, LLAMA_PORT.
# Extra llama-server flags can be passed as arguments.
llama-qwen() {
    local model="${LLAMA_MODEL:-$LLAMA_DEFAULT_MODEL}"
    local moe="${LLAMA_MOE:-34}"
    local ctx="${LLAMA_CTX:-65536}"
    local threads="${LLAMA_THREADS:-6}"
    local port="${LLAMA_PORT:-8090}"

    if [[ ! -f "$model" ]]; then
        echo "llama-qwen: model not found: $model" >&2
        return 1
    fi

    echo "llama-qwen: moe=$moe threads=$threads ctx=$ctx port=$port" >&2

    "$LLAMA_BIN/llama-server" \
        -m "$model" \
        -ngl 99 \
        --n-cpu-moe "$moe" \
        -c "$ctx" \
        --flash-attn 1 \
        --cache-type-k q8_0 \
        --cache-type-v q8_0 \
        -t "$threads" \
        -b 512 \
        --ubatch-size 512 \
        --jinja \
        --alias qwen3.6-35b-a3b \
        --host 0.0.0.0 \
        --port "$port" \
        "$@"
}

# Sweep thread counts and report prompt/generation throughput as a markdown table.
# Usage: llama-sweep-threads [comma-separated thread counts]
llama-sweep-threads() {
    local model="${LLAMA_MODEL:-$LLAMA_DEFAULT_MODEL}"
    local threads="${1:-6,8,10,12}"

    "$LLAMA_BIN/llama-bench" \
        -m "$model" \
        -t "$threads" \
        -o md
}

# Confirm the server is up and see which model alias it is serving.
alias llama-check='curl -s http://localhost:${LLAMA_PORT:-8090}/v1/models'

# Live GPU telemetry while generating.
alias llama-vram='watch -n 1 nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.sm --format=csv'
