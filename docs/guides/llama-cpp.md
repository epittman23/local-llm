# Local inference with llama.cpp

Local self-hosting is now being tested alongside the OpenRouter setup, using
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, which
exposes the same OpenAI-compatible API Open WebUI already speaks. Pointing
Open WebUI at it is a connection-settings change only (see [Migrating to local
hardware later](../../README.md#migrating-to-local-hardware-later)).

## Building llama.cpp

The Serve page runs `llama-server` from `LLAMA_BIN` (default
`~/llama.cpp/build/bin`; see `serving/launcher.py`), so llama.cpp has to be
built there with CUDA. That needs the NVIDIA driver, the CUDA toolkit
(`nvcc`) and `cmake`. On Fedora the CUDA toolkit comes from NVIDIA's own
repository, which needs sudo; check that the toolkit release accepts the
system GCC as its host compiler, and install an older `gcc` for it if not.
`cmake` is also available from linuxbrew without sudo. The current recorded
serving measurements used build 10597 (`95b8e33e1`); the thread-count sweep
is older, on 10472. Building 10597 keeps new runs comparable with the recorded
ones:

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp && cd ~/llama.cpp
git checkout 95b8e33e1
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=86
cmake --build build -j "$(nproc)"
```

`86` is the RTX 3060 Laptop's compute capability (8.6). On 2026-10-09 the
Fedora machine had the driver (615.71) and `cmake` but neither the CUDA
toolkit nor a llama.cpp build, so nothing has been served on native Linux
yet.

## Serving

Serving lives entirely in the backend now — there is no shell layer or
`~/.bashrc` helper to source any more (`scripts/shell/main.sh` and everything
under `scripts/` were deleted in Phase 2c of the migration, 2026-09-18; see the 2026-09-18 entry in
[docs/decisions.md](../decisions.md)). Start a server, stop it, and edit or pick
a profile from the fork's own **Serve** page at `/benchmarks/serve` (admin
only) once `make backend` is running — see [benchmarks.md](benchmarks.md) for
what that page and its siblings do.
GPU telemetry while a server runs is the **Live** page, `/benchmarks/live`.

Serving settings are grouped into profiles rather than scattered across env
vars, stored in Postgres (`benchmark_profile`/`benchmark_profile_version`,
versioned and append-only — editing a profile inserts a new version rather
than overwriting one) and resolved by
`apps/server/local_llm/benchmarks/serving/profiles.py`. The
Serve page's profile list shows all four and whether their weights are on
disk; the table below is the same information for reference:

| profile | arch  | model                                    | size on disk | ctx   | threads | ngl | slots | n-cpu-moe | override-tensors                         |
| ------- | ----- | ---------------------------------------- | -----------: | ----- | ------: | --: | ----: | --------: | ---------------------------------------- |
| qwen36  | MoE   | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`        |    20.81 GiB | 65536 |       6 |  99 |     1 |        34 | n/a                                      |
| qwen38  | dense | `Qwen3.8-27B-UD-Q3_K_XL.gguf`            |    12.24 GiB | 16384 |      12 |  20 |     1 |       n/a | `output\.weight`, `blk\.64\..*` -> CUDA0 |
| qwen25c | dense | `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`  |     4.36 GiB | 16384 |       6 |  99 |     1 |       n/a | n/a                                      |
| qwen3c  | MoE   | `Qwen3-Coder-30B-A3B-Instruct-Q4_1.gguf` |    17.87 GiB | 65536 |       6 |  99 |     1 |        34 | n/a                                      |

As of 2026-10-09, only `qwen38`'s weights are on disk
(`~/models/qwen38-27b/Qwen3.8-27B-UD-Q3_K_XL.gguf`, 13,146,393,504 bytes,
the same size Hugging Face lists for it). The other three have to be
downloaded first ([model-downloads.md](model-downloads.md)); the Serve page's profile list
shows the same thing.

`qwen25c` is the only profile here whose weights fit in 6 GB outright, so
`-ngl 99` puts all 28 blocks and the output head on the GPU and nothing is read
from system RAM. That is the whole reason it exists: `qwen36` and `qwen38` are
3-5x this card and are bound by how fast their CPU-resident weights can be read,
which is what holds them to single-digit tokens/s. Nothing about its throughput
is measured yet, so no figure for it is quoted here; running the `smoke` tier
against a served instance from the Benchmarks section's Tests page is what
would produce one. It needs no `-ot` (nothing
is left on the CPU to pin), sets no speculative flags (Qwen2.5 predates the
`nextn` tensors `qwen38` drafts from), and sets no reasoning effort: it is not a
thinking model, so responses carry no `reasoning_content` and the token budget
is all answer. Its samplers are Qwen2.5-Coder's own
(`--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1`), which govern Open
WebUI traffic; the Benchmarks section's Tests page pins temperature to 0 in
its request body either way.
Its context is 16384 rather than the model's full 32768 because the KV cache
here costs ~29.7 KiB/token at `q8_0` (28 layers, 4 KV heads of 128): ~476 MiB at
16K against ~952 MiB at 32K, on top of 4.36 GiB of weights and the compute
buffer. The full window fits inside 6 GiB only with tighter margin than is
comfortable, so raising it is opt-in — the Serve page's `ctx` override field —
and worth confirming against the Live page's free-VRAM figure rather than
assuming it fits.

`qwen3c` (`unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, `Q4_1`, 17.87 GiB,
alias `qwen3-coder-30b-a3b`) is a fourth profile. Its weights are not on
disk on the current machine (as of 2026-10-09), and
**nothing about it is measured yet**: no throughput figure and no run from
the Benchmarks section's Tests page. It follows the same `qwen36` shape — sparse MoE, `-ngl 99`
with `--n-cpu-moe 34` since the model is ~4.1x this card's 6 GB VRAM, `q8_0`
KV cache, 65536 context, 6 threads — copied as a starting point rather than
independently tuned; the Serve page's `moe`/`ctx` override fields, plus an
`llama-bench` GPU-layer sweep (see "Preflight sweeps" below), are how that
would actually get confirmed. It sets no `-ot` and no speculative flags:
unlike `qwen38`, nothing here has checked this GGUF for an MTP head.

`qwen38`'s `-ngl 20` is a placeholder pending a GPU-layer sweep;
`--n-cpu-moe` is MoE-only and the resolver refuses to pass it to a dense
model. `qwen38` also pins two tensor groups to the GPU with `-ot` regardless
of `-ngl` — the output projection and the final block (the model has 65
blocks, `blk.0` to `blk.64`), both touched on every token. The sweep below
passes the same `-ot`, so its VRAM headroom matches what the Serve page will
see; override a served run's tensor pinning with the `ot` field. The server's
own startup log (streamed live on the Serve page) still names the actual
`n_layer` split it chose, worth checking before treating an `-ngl` as tuned —
but only for a dense profile that is partially offloaded: at `-ngl 99` there
is no layer count being chosen.

It additionally runs speculative decoding off the model's own multi-token
prediction head (`--spec-type draft-mtp --spec-draft-n-max 2`), so
no separate draft model is needed: the weights carry
`qwen35.nextn_predict_layers = 1` and `blk.64.nextn.*` tensors, and `-ot`
already keeps that block on the GPU. A draft depth of 2 is deliberately
conservative — rejected drafts cost real compute on a model this CPU-bound.
The Benchmarks section's Tests page reports `draft_n` and `draft_n_accepted`
in its timings, which is the acceptance rate to judge it by. The Serve
page's `spec` override field turns it off for an A/B (empty replaces the
profile's flags with none) or replaces them with a different set entirely —
the same three-valued behavior `LLAMA_SPEC` had in the shell (unset keeps the
profile's flags, empty/`off` turns them off, anything else replaces them),
now a typed field instead of an environment variable. `qwen36` sets none of
this: its weights are not on disk here, so its MTP support is unverified.

Every profile serves with `--parallel 1` (one server slot), overridable with
the Serve page's `parallel` field. This is passed unconditionally and independently of the
speculative flags, because omitting `--parallel` is *not* the same as passing
1: `llama-server` defaults it to `-1` (auto), and auto means **4 slots with
`kv_unified = true`** (build 10597, `common/arg.cpp:1400` and
`tools/server/server.cpp:152-155`). `-c` is the total context, which
non-unified slots divide between them, so the slot count changes the attention
and KV-cache configuration whether or not it changes capacity. Until
2026-08-23 `--parallel 1` was bundled into `qwen38`'s speculative flags, so
every `LLAMA_SPEC=off` baseline silently ran 4 unified slots — measured at
15.63 t/s prompt processing against 26.38 t/s at one slot. Any comparison
recorded before that date between a speculative run and a non-speculative one
is invalid, in the direction that flatters speculation. Passing `--parallel`
inside the `spec` override is refused for the same reason; use the
`parallel` field.

What the old shell functions became, now that `scripts/` is gone (Phase 2c,
2026-09-18):

| shell command | now |
| --- | --- |
| `lllm-serve [profile]` | Serve page, `/benchmarks/serve` — pick a profile, set overrides (`ngl`, `ctx`, `threads`, `parallel`, `ot`, `reasoning`, `spec`), start. Server log streams live in the page. `--metrics` and `-lv 4` are still always passed underneath, for the same reasons as before (server-wide token totals; the load-info block), and are still excluded from the config fingerprint |
| `lllm-fetch [profile]` | no UI: `serving/weights.py`'s `FetchProcess` exists but no route mounts it, so it is the `hf` CLI by hand, see [model-downloads.md](model-downloads.md) |
| `lllm-sweep-threads`, `lllm-sweep-ngl` | deleted outright (superseded by Tune's paired search); the raw `llama-bench` invocations are preserved below under "Preflight sweeps" |
| `lllm-check` | the Serve page shows whether a server is running directly, no separate check |
| `lllm-vram` | Live page, `/benchmarks/live` — polled GPU telemetry, free VRAM called out |
| `lllm-profiles`, `lllm-profile-json`, `lllm-profile-names` | the Serve page's profile list (full CRUD: list, create, clone, edit as a new version, archive, set default) |

Profile CRUD replaces `scripts/shell/main.sh` as the single source of truth
for serving configuration with the `benchmark_profile`/
`benchmark_profile_version` tables in Postgres, resolved through
`serving/profiles.py`; a profile's `name` is immutable once created (its
`display_name` isn't), so tuning search spaces named after it never orphan.

### Preflight sweeps

`lllm-sweep-threads`/`lllm-sweep-ngl` are gone rather than ported: Tune's
round-elimination search over served, correctness-checked runs supersedes
them for actually choosing a configuration, and `main.sh` already documented
these two as feasibility pre-screens, not a source of comparable
measurements (their numbers never went into Postgres). Their raw
`llama-bench` invocations still work — `llama-bench` is a llama.cpp binary,
not something this repo wraps — and are preserved here for anyone tuning a
profile's `-ngl`/`--n-cpu-moe` before touching the Serve page. Paths below
are the shell tooling's old defaults (`~/llama.cpp/build/bin`, `~/models/`);
substitute your own.

Thread sweep, any profile:

```bash
~/llama.cpp/build/bin/llama-bench -m <model path> -t 4,6,8,10 -ngl <ngl> \
  [--n-cpu-moe <moe>] -o md
```

GPU-layer sweep, dense profiles (`qwen38`, `qwen25c`) — one process per
value on purpose: `llama-bench` retained GPU allocations across model reloads
on WSL2 (not rechecked on native Linux), so reusing one process across values would contaminate every
configuration after the first with the previous one's leftover allocation.
`-ot` is passed through so headroom matches what the Serve page will
actually see:

```bash
for v in 12 16 20 24; do
  ~/llama.cpp/build/bin/llama-bench -m <model path> -ngl "$v" \
    [-ot '<override-tensors>'] -t <threads> -p 512 -n 128 -o md
  sleep 3
done
```

MoE profiles (`qwen36`, `qwen3c`) sweep `--n-cpu-moe` instead, at `-ngl 99`:

```bash
~/llama.cpp/build/bin/llama-bench -m <model path> -ngl 99 \
  --n-cpu-moe 30,32,34,36 -o md
```

Neither sweep writes to Postgres; their numbers are pre-flight only; they do
not survive the terminal and are not comparable with anything the Benchmarks
section records.

## Hardware and model

- GPU: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM (compute capability 8.6).
- Host: 20 threads and 62 GiB RAM, on native Fedora 44 since 2026-10-09.
  **Every measurement in these guides was taken under WSL2**, before that
  move. Same hardware, but a different kernel, driver stack and memory path
  (which matters most for the CPU-resident MoE experts). Treat the numbers
  as historical until they are re-measured on native Linux.
- Model: `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` : 34.66 B total parameters, ~3 B
  active per token (MoE), 20.81 GiB on disk.

The weights are far larger than 6 GB of VRAM, so all layers are offloaded
(`-ngl 99`) but the MoE expert tensors of 34 layers are kept in system RAM
(`--n-cpu-moe 34`). The KV cache is quantized to `q8_0` with flash attention
enabled to fit a 64K context.

## Verifying the server

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

## Measurement: qwen38 with MTP speculative decoding

> **Prompt source changed 2026-08-30; these numbers still stand.** The runs
> below were measured on `prompts/humaneval0-4.txt`, hand-typed files that
> collapsed the two blank lines the canonical HumanEval stub carries between its
> import and its `def`. The test harness now renders prompts from the dataset
> itself, so each of these five prompts is two bytes longer than the string that
> was measured. Checked against the server's `/tokenize` on 2026-08-30 rather
> than assumed: all five tokenize to **the same length as before** (135, 127,
> 96, 130, 129 content tokens) and differ in exactly **one token id** each — the
> newline run absorbs the added blank lines. Same token count, same prefill
> work, so these figures remain comparable to runs made after the change.
> `humaneval0`-`humaneval4` here are `HumanEval/0`-`HumanEval/4` under the new
> naming. See the 2026-08-30 entry in [docs/decisions.md](../decisions.md).

One HumanEval item (`HumanEval/0`, run from the Benchmarks section's Tests
page) against the `qwen38` profile (then served by `lllm-serve`, since
deleted), build `95b8e33e1`
(10597), on the RTX 3060 Laptop (6 GB). Serving flags: `-ngl 20`,
`-ot "output\.weight=CUDA0,blk\.64\..*=CUDA0"`, `-c 16384`, `-t 12`,
`--cache-type-k/v q8_0`, `-fa on`, `-b 512 --ubatch-size 512`,
`--spec-type draft-mtp --spec-draft-n-max 2 --parallel 1`, reasoning effort
`medium`, temperature 0:

| metric                | value        |
| --------------------- | -----------: |
| generation            |  2.89 t/s    |
| prompt processing     | 51.41 t/s    |
| completion tokens     |          958 |
| drafted tokens        |          690 |
| drafted tokens accepted |        613 |
| VRAM in use           | 5519/6144 MiB |

Acceptance is 88.8% and drafts cover 72% of the generated tokens, which is a
healthy rate for an MTP head. The throughput gain is nonetheless modest, and
this is **not yet a clean A/B**: the only non-speculative measurement to hand
(2.50 t/s) came from a server that also differed in `-ngl` (22) and had no
`-ot`, and it produced a shorter completion. Serving `qwen38` with the Serve
page's `spec` field empty, then running the same item again from the Tests
page, is the comparison to make — and
before 2026-08-23 it would not have been valid either, because dropping the
speculative flags also dropped `--parallel 1` and left the baseline serving 4
unified slots (fixed 2026-08-23; see the slot-count paragraph above).

Note the whole request took ~5.5 minutes: 958 tokens at ~2.9 t/s, most of them
reasoning tokens emitted before any answer text. Generation here is bound by
system-RAM bandwidth for the CPU-resident layers, which is also why drafting
helps less than its acceptance rate suggests.

**Four-prompt run, 2026-08-24T02:39:18Z**, same build and same flags as above,
one server, four cold prefills (`cache_prompt: false`), 2048-token cap,
reasoning effort `medium`, temperature 0:

| prompt      | prompt tok | prefill t/s | output tok | generation t/s | drafted | accepted | acceptance | answer  |
| ----------- | ---------: | ----------: | ---------: | -------------: | ------: | -------: | ---------: | ------- |
| humaneval1  |        136 |       42.73 |       1066 |           3.00 |     754 |      688 |      91.2% | correct |
| humaneval2  |        105 |       41.26 |        499 |           2.87 |     364 |      318 |      87.4% | correct |
| humaneval3  |        139 |       55.24 |        499 |           2.98 |     348 |      324 |      93.1% | correct |
| humaneval4  |        138 |       52.96 |        613 |           2.98 |     420 |      404 |      96.2% | correct |
| **run**     |        518 |   **47.74** |       2677 |       **2.97** |    1886 |     1734 |  **91.9%** | 4/4     |

All four solutions were correct. Generation sits in a 2.87-3.00 t/s band across
prompts, so a difference smaller than that band is noise, not a result.
**Prefill is far less stable than it looks from one prompt**: 41.26 to 55.24 t/s
across cold prompts of nearly the same length (105-139 tokens), a 34% spread
under identical flags. Peak VRAM 5521/6144 MiB, 623 MiB headroom, `fused_gdn`
enabled, `GpuIdle` and `SwPowerCap` both observed. GPU utilization averaged 13%
over the samples that saw work — the CPU-resident layers, not the GPU, are what
this configuration waits on.

## Benchmark: thread-count sweep

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

These numbers were measured with build `60eeeb608` (10472) and are historical:
the current build is newer, and the thread sweep under [Preflight
sweeps](#preflight-sweeps) passes a profile's `-ngl` and `--n-cpu-moe`, so it
benchmarks the serving configuration rather than llama-bench's defaults. Re-measure before relying on them.
