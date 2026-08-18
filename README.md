# Personal AI Assistant

A personal AI assistant running on cloud-hosted open-weight models via
OpenRouter, using [Open WebUI](https://github.com/open-webui/open-webui) as
the chat interface. See `CLAUDE.md` for the full project rationale.

Open WebUI runs in Docker and talks directly to OpenRouter's OpenAI-compatible
API — there is no custom backend or frontend code in this repo; Open WebUI
*is* the app.

## Running it

Requires Docker Desktop with WSL integration enabled for this distro
(Docker Desktop → Settings → Resources → WSL Integration).

```bash
docker run -d \
  -p 3000:8080 \
  -e OPENAI_API_BASE_URL=https://openrouter.ai/api/v1 \
  -e OPENAI_API_KEY=<your OpenRouter API key, from https://openrouter.ai/keys> \
  -v open-webui:/app/backend/data \
  --name open-webui \
  --restart unless-stopped \
  ghcr.io/open-webui/open-webui:main
```

Then open `http://localhost:3000`. The first account you create becomes the
admin. Chat history, settings, and the model list are persisted in the
`open-webui` Docker volume.

## Model setup

Under **Workspace → Models**, this project defines one Open WebUI model entry
per task, each wrapping a specific OpenRouter model id:

- **Coding** → `qwen/qwen-2.5-coder-32b-instruct`
- **Reasoning** → `qwen/qwen3.6-27b`

Both models are configured (per-model, in the System Prompt field) with the
following instructions:

```
Please use a formal, professional tone. When applicable, try to explain solutions and their steps.
Be informative and delve into topics to enhance learning and further understanding.
Please prioritize accuracy and correctness for all responses.
If there are any assumptions you make for any response please clearly state them and do not hesitate to ask clarifying questions before providing a full response.
Never use em-dashes, instead use standard punctuation such as colons and semicolons.
```

Model choices and reasoning for changing them are logged in the "Decisions
log" section of `CLAUDE.md`.

## Local inference (llama.cpp)

Local self-hosting is now being tested alongside the OpenRouter setup, using
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, which
exposes the same OpenAI-compatible API Open WebUI already speaks. Pointing
Open WebUI at it is a connection-settings change only (see "Migrating to local
hardware later" below).

Helper functions and aliases live in `llama-local.sh`. Source it from
`~/.bashrc`:

```bash
[ -f "$HOME/dev/repos/home-llm/llama-local.sh" ] && . "$HOME/dev/repos/home-llm/llama-local.sh"
```

It provides:

- `llama-qwen` : start `llama-server` on port 8090 serving the model under the
  alias `qwen3.6-35b-a3b`. Tunable via env vars: `LLAMA_MODEL`, `LLAMA_MOE`
  (layers whose MoE experts stay on CPU, default 34), `LLAMA_CTX` (default
  65536), `LLAMA_THREADS` (default 6), `LLAMA_PORT` (default 8090). Any extra
  arguments are passed through to `llama-server`.
- `llama-sweep-threads [4,6,8,...]` : run `llama-bench` across thread counts
  and print a markdown table.
- `llama-check` : `GET /v1/models` against the running server.
- `llama-vram` : live `nvidia-smi` GPU telemetry.

### Hardware and model

- GPU: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM (compute capability 8.6).
- Model: `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` : 34.66 B total parameters, ~3 B
  active per token (MoE), 20.81 GiB on disk.

The weights are far larger than 6 GB of VRAM, so all layers are offloaded
(`-ngl 99`) but the MoE expert tensors of 34 layers are kept in system RAM
(`--n-cpu-moe 34`). The KV cache is quantized to `q8_0` with flash attention
enabled to fit a 64K context.

### Verifying the server

```bash
curl -s -X POST http://localhost:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Count from 1 to 30, one number per line."}],"max_tokens":600}'
```

This returns a normal `chat.completion` object; note that the model is a
thinking model, so its chain of thought arrives in a separate
`reasoning_content` field alongside `content`. On the run used for these
notes, 480 completion tokens (most of them reasoning) took ~92 s, i.e. ~5.2
tokens/s end to end, with a 24-token prompt taking ~1.3 s to prefill.

### Benchmark: thread-count sweep

`llama-bench` on the configuration above (`-ngl 99 -ncmoe 34`), build
`60eeeb608` (10472):

| threads | pp512 (t/s)    | tg128 (t/s) |
| ------: | -------------: | ----------: |
|       4 |  71.75 ± 11.44 | 7.38 ± 0.50 |
|       6 |  75.82 ± 9.24  | 7.90 ± 0.69 |
|       8 |  75.99 ± 13.02 | 7.41 ± 0.43 |
|      10 |  74.85 ± 12.16 | 7.94 ± 0.56 |
|      12 |  76.32 ± 12.18 | 7.40 ± 0.58 |
|      14 |  78.27 ± 17.11 | 7.08 ± 0.45 |

Thread count barely matters here: prompt processing gains ~9% from 4 to 14
threads, and generation is flat at roughly 7.1 to 7.9 t/s with the run-to-run
spread larger than the differences between settings. Generation is bound by
system-RAM bandwidth for the CPU-resident experts, not by CPU cores. The
default of 6 threads is kept since nothing above it pays for itself.

Note that `llama-sweep-threads` does not pass `-ngl`/`-ncmoe`, so it benchmarks
llama-bench's defaults rather than the `llama-qwen` serving configuration; add
those flags to reproduce the table above.

## Migrating to local hardware later

When ready to self-host (llama.cpp as above, or Ollama/vLLM), update the
connection under **Admin Panel → Settings → Connections**: change the base URL
to your local server's OpenAI-compatible endpoint (`http://localhost:8090/v1`
for the `llama-qwen` server above, or `http://localhost:11434/v1` for Ollama),
and update the API key if your local server requires one. No other
changes should be necessary, since Open WebUI talks to any OpenAI-compatible
endpoint.
