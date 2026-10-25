# Plan: which local models to run, and how

Status: **analysis for the owner's decision, 2026-10-25.** No model in this
document has been downloaded for it. Each recommendation names a Hugging
Face repo and file, and serving any of them needs a new profile row, which
is an owner decision (section 7). The models already on disk are listed in
section 2.

Scope: the ten entries of an Artificial Analysis "Model Recommendation
Report" (Intelligence weighted highest, then Speed, then Cost; focus on low
hallucination, agentic use, coding and instruction following; open weights,
"small"; reasoning), checked against this machine, this repo's harness and
the owner's preference for uncensored variants. The ten entries are eight
models: Qwen3.8 27B appears at three reasoning-effort levels.

What was done:

- **Research.** Every model's card, config, chat template and licence; llama.cpp's source
  at the installed commit; and Hugging Face file listings through the API.
  GGUF headers were read with HTTP range requests (metadata only), to check
  tensor types, embedded templates and MTP heads. No weights were
  downloaded.
- **Measured on this machine,** 2026-10-24 to 25: structured tool calls and
  `smoke`-tier runs, bare and through the app's chat pipeline (harness
  mode, PR #415), for four small models (section 3).

Sources are linked in place. A claim found in only one non-official source
is marked **(single source)**.

---

## 1. Summary

- **Only two shortlisted models fit fully on the 6 GB GPU,** each with
  little room to spare:
  - Nemotron Nano 9B v2 at about 4.9 GiB;
  - Gemma 4 12B, but only at about 3 bits.

  The others are 11–31 GiB at 4 bits. They run with most weights in system
  RAM, at roughly 3 tokens/s (Qwen3.8 27B, dense) to an estimated 7–15
  tokens/s (the mixture-of-experts models, which read only their active
  experts per token).
- **The report's "Speed" column is cloud API speed, not local speed,** and
  the report weights speed heavily. That is why Nemotron 3 Nano Omni
  (Intelligence 10) ranks first and Qwen3.8 27B (Intelligence 34) ranks
  second. On this machine the order of speeds is different, and the
  intelligence gap is the larger effect.
- **The best models for this machine fall into three tiers** (section 7):
  1. **Fully on the GPU, fast:** Qwen3-4B-Instruct-2507 (measured here), and
     Gemma 4 E4B and Nemotron Nano 9B v2 to test.
  2. **Mixture of experts with the experts in RAM, smarter, moderate speed:**
     Gemma 4 26B A4B and gpt-oss-20b. These are the best fit for this machine
     that the report offers.
  3. **Dense and partly offloaded, smartest, slow, for hard problems:**
     Qwen3.8 27B, already on disk, or its Heretic build.
- **Uncensored variants.** Unsloth publishes quantizations, not uncensored
  models: an API search of its repos for "abliterated", "heretic" and
  "uncensored" returns nothing. So "uncensored from unsloth" does not exist.
  - **The reputable path is [Heretic](https://github.com/p-e-w/heretic).**
    Its runs publish a KL divergence from the original and a refusal count.
    The most trustworthy builds come from p-e-w himself (gpt-oss-20b) and
    from the `heretic-org` organisation (Qwen3.8 27B).
  - **Next most trustworthy:** llmfan46, an individual who also publishes MMLU
    and PIQA before and after.
  - **Quantized GGUFs** of these come from mradermacher or bartowski.
  - **Where this document recommends one:** a Heretic build with published
    numbers exists. Where the evidence says uncensoring costs a lot, or the
    licence forbids it, the document says so.
  - **What no uncensored variant has measured:** tool calling. The harness
    measures it.
- **Two things to settle before relying on harness mode** (section 4):
  - The grading rule penalises a model for using the code interpreter on
    code-writing benchmarks.
  - The installed llama.cpp is older than its build date suggests (section
    6).

## 2. This machine

| | |
|---|---|
| GPU | RTX 3060 Laptop, 6,144 MiB; about 6.0 GiB usable (the desktop runs on the Intel GPU) |
| CPU | i9-12900H, 20 threads |
| RAM | 62 GiB |
| llama.cpp | build 10597, commit `95b8e33e1`, **a commit dated 2026-08-23**, built 2026-10-23 with CUDA 13.4 |
| On disk | `qwen38` Qwen3.8-27B-UD-Q3_K_XL (12.24 GiB), `qwen25c` Qwen2.5-Coder-7B Q4_K_M, Qwen3.5-4B Q6_K, Qwen3-4B-Instruct-2507 Q6_K |

**What fits.** A model runs at full speed only if its weights, its KV cache
and about 0.6 GiB of CUDA context and compute buffers all fit in the 6 GB:
roughly a 4.5–5 GiB file at a 16k context. Anything larger runs partly from
system RAM, and generation speed is then set by RAM bandwidth.

For a mixture-of-experts model, llama.cpp can keep the attention weights on
the GPU and the experts in RAM (`--n-cpu-moe`). Only the active experts are
read per token, which is why a 30B-A3B model runs faster than a dense 27B.

---

## 3. Measured on this machine

All measured runs used llama.cpp b10597 with `-ngl 99 -c 16384 --cache-type-k q8_0 --cache-type-v q8_0 --jinja -fit off`,
unless a profile is named. The `smoke` tier is 24 items: 8 each of
HumanEval, MBPP and DS-1000. "Through the app" means harness mode, PR #415:
a Workspace model entry with the deployed `assistant.txt` prompt, and
`execute_code` on the Jupyter engine.

**Structured tool calls.** Each model got the exact `execute_code` spec the
app sends, under three system prompts (the app's own, a one-line one, and
none), for two tasks:

| Model | File | VRAM | Structured calls |
|---|---|---|---|
| Qwen2.5-Coder-7B (`qwen25c`) | Q4_K_M, 4.36 GiB | 4,987 MiB | **0 of 6**: writes the call as JSON text in a code fence |
| Qwen3.5-4B | Q6_K, 3.28 GiB | 4,151 MiB | **6 of 6** |
| Qwen3-4B-Instruct-2507 | Q6_K, 3.08 GiB | 4,671 MiB | **6 of 6** |
| Qwen3.8 27B (`qwen38` profile) | UD-Q3_K_XL | 5,571 MiB (partial offload) | made a structured call that ran; one probe only |

`qwen25c`'s own chat template asks for `<tool_call>…</tool_call>` tags, the
format llama.cpp parses. The model writes fenced JSON instead, so the
failure comes from its training, not the app. It does follow the app's
*legacy* `<code_interpreter>` tags when a task needs computing. Harness mode
supports native calls only (plan D3), so this route is not available there.

**`smoke` runs, bare and through the app:**

| Model | Bare | Through the app | Items that ran code | Seconds per item, bare / app |
|---|---|---|---|---|
| Qwen2.5-Coder-7B | 18 | 17 | 0 | 5.1 / 7.0 |
| Qwen3-4B-Instruct-2507 | 16 | 14 (**16** with the fallback below) | 14 | 2.6 / 16.8 |
| Qwen3.5-4B (thinking) | 15 | 12 of 24 (**14** of the 21 answered, with the fallback) | 11 | 20.6 / 33.6 |

On 24 items, a difference of two is not evidence either way. What the runs
do show:

- **Tool calls work end to end** on both Qwen3 4B models: the call, Jupyter,
  then a second round.
- **The code interpreter does not raise scores** on these code-writing
  items.
- **Thinking costs time:** Qwen3.5-4B wrote about 2,700 characters of
  reasoning per item and took eight times as long as Qwen3-4B-2507, for no
  better score.

## 4. A grading problem found while measuring

After running and testing its code, a model often ends with a prose summary
instead of repeating the code, for example MBPP 224 on Qwen3-4B-2507. Plan
D6 grades only the final message, so the grader ran that prose and recorded
a `SyntaxError`, although the code the model had tested was correct.

Re-grading the stored answers offline confirms this. Grading "the final
message, or the last code it ran when the final message has no code" moved:

- Qwen3-4B-2507 from 14 to **16**, its bare score; the fallback was used on
  5 items;
- Qwen3.5-4B from 12 to **14** of the 21 answered; used on 6 items.

**This is a decision for the owner, not a bug fix.** Three options:

1. **Keep D6 as written.** It measures exactly what a user reads, but on
   code-writing benchmarks it penalises using the interpreter.
2. **Fall back to the last executed code** when the final message contains
   no fenced code, and record which one was graded. **Recommended.** It
   matches how a person reads such a chat, and it changes nothing for
   answers that repeat their code.
3. **Tell the model in harness mode to end with its final code in a fence.**
   That changes the prompt being measured, and so the harness sha.

---

## 5. The shortlisted models

### 5.1 Qwen3.8 27B (Intelligence Index 34 Xhigh / 28 Medium / 26 Low)

- **What it is:** dense, 27B, released August 2026, [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), Apache-2.0.
  - 64 layers: 48 Gated DeltaNet (linear attention) and 16 full-attention.
  - One MTP head, a 262k context, and text, image and video input.
  - Only the 16 attention layers hold a KV cache: about 34 MiB per 1k tokens
    at q8_0, plus about 150 MiB of fixed recurrent state.
- **Tool calls:** Qwen3-Coder XML, parsed natively by this build. Measured
  here: a structured call that ran.
- **Reasoning effort is a chat-template switch,** with only `xhigh` (the
  default), `medium` and `low`; `none` turns thinking off. It is set per
  request (`"reasoning_effort": "low"`), or as the server default with
  `--reasoning-effort medium`. Artificial Analysis needed 200M output tokens
  at xhigh, 110M at medium and 82M at low to run its index
  ([page](https://artificialanalysis.ai/models/qwen3-8-27b)). At about 3
  tokens/s, xhigh is roughly 1.8 times the wall-clock time of medium.
- **Fit:** no quantization fits fully; even the 1-bit UD-IQ1_S is 5.77 GiB.
  The existing `qwen38` profile (`-ngl 20`, MTP depth 2) measured about 3
  tokens/s under WSL2, historically. On Fedora it has been load-checked
  only.
- **The template.** Only unsloth's GGUFs carry unsloth's patched chat
  template:
  - it maps `reasoning_effort: "high"` to `xhigh`, where the official
    template raises an error on anything other than its three values;
  - it merges system and developer messages.

  Every other GGUF embeds the official template. Serve those with
  `--chat-template-file` pointing at unsloth's.
- **Uncensored variants.** None from unsloth, mlabonne or p-e-w himself.
  - **[heretic-org/Qwen3.8-27B-heretic-ara](https://huggingface.co/heretic-org/Qwen3.8-27B-heretic-ara)**,
    from the organisation linked by Heretic's own README. It reports a KL of
    0.0535 and 0 of 100 refusals, against 99 of 100 for the original. GGUFs
    are by mradermacher. The MTP head and the official template are
    **verified present** in the GGUF headers.
  - [huihui-ai's abliterated build](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF)
    was ablated directly from unsloth's quants. It publishes no KL or
    refusal numbers, and its UD-IQ2_S file lacks the MTP head.
  - Two other uploaders (llmfan46, HauhauCS) either replace the chat template
    or publish no method. They are not recommended.
  - The KL figures come from different prompt sets, so they cannot be ranked
    against each other. No coding or tool-use deltas were published for any
    variant.
- **Recommendation:**
  - **Uncensored:** `mradermacher/Qwen3.8-27B-heretic-ara-i1-GGUF` → `Qwen3.8-27B-heretic-ara.i1-Q3_K_M.gguf` (**12.57 GiB**, verified).
    - It is the same size class as the current file, so the `qwen38`
      profile's offload settings should carry over, with `-ngl 19` or 20.
    - It is a K-quant, which runs faster on the CPU-resident layers than an
      IQ quant.
    - Serve it with unsloth's template and `--reasoning-effort medium`, and
      send `low` for interactive turns.
  - **Base (already on disk):** `unsloth/Qwen3.8-27B-GGUF` → `Qwen3.8-27B-UD-Q3_K_XL.gguf` (12.24 GiB). It is the only Qwen3.8 file measured here.

### 5.2 Qwen3 Omni 30B A3B Reasoning (Intelligence Index 8)

- **What it is:** a mixture-of-experts model, about 30B total and 3B active,
  with text, image, audio and video input, released September 2025.
  [Qwen/Qwen3-Omni-30B-A3B-Thinking](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Thinking),
  Apache-2.0, 65k context, Hermes-format tool calls.
- **Weaker for this project's uses.** Its own card shows it below
  Qwen3-30B-A3B-Thinking-2507 on what matters here:
  - AIME25: 73.7 against 85.0;
  - BFCL-v3: 63.2 against 72.4;
  - IFEval: 85.1 against 88.9.
- **Fit:** text and vision work in this llama.cpp build. Audio input was
  reported broken in [#27136](https://github.com/ggml-org/llama.cpp/issues/27136),
  which was closed as stale, not fixed. Audio output is not supported.
- **Recommendation: skip it for this project's uses.** If audio or video
  input is ever needed, use `mradermacher/Qwen3-Omni-30B-A3B-Thinking-heretic-i1-GGUF` → `…heretic.i1-Q4_K_M.gguf` (17.28 GiB).
  It reports a KL of 0.0036 and 7 of 100 refusals **(single source)**. Serve
  it with `--n-cpu-moe` around 41 at 32k context.

### 5.3 NVIDIA Nemotron 3 Nano Omni 30B A3B Reasoning (Intelligence Index 10)

- **What it is:** a hybrid Mamba-2/Transformer mixture of experts.
  - 31B total, about 3B active.
  - 52 layers, of which only 6 are attention, so its KV cache is tiny: 6 KiB
    per token.
  - Video, audio, image and text input; English; released April 2026.
  - [nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16](https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16).
- **Licence:** NVIDIA Open Model Agreement. It has **no** guardrail clause,
  so modifying the model is not a licence problem.
- **Tool calls:** Qwen3-Coder XML, parsed natively by this build. Thinking is
  on by default; `--reasoning off` or `/no_think` turns it off.
- **Two quirks:**
  - **Its tensor widths are not multiples of 256,** so llama.cpp silently
    raises every quantization below about 4 bits to roughly 4 bits. The
    "2-bit" files are 17 GiB.
  - **[#30894](https://github.com/ggml-org/llama.cpp/issues/30894) is not in
    this build:** the wrong pre-tokenizer is applied. English is unaffected.
- **Fit:** text only, with no `--mmproj`. Use `-ngl 99 --n-cpu-moe 49 -c 65536`,
  which puts about 3 GiB on the GPU. That is an estimate; confirm it from
  the serve log. The estimated speed is 7–15 tokens/s; nothing has been
  published for similar hardware.
- **Uncensored variants: not recommended.**
  - None comes from huihui-ai, mlabonne or Heretic.
  - The one carefully measured attempt reports GPQA Diamond falling from
    about 46% to 30% **(single source)**. It also states that
    projection-based abliteration "collapsed" GPQA to about 27% on this
    architecture.
- **Recommendation:** `unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF` → `NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_XL.gguf` (**22.28 GiB**, verified).
  - It has an importance matrix and the official template.
  - Its experts are actually Q5_0/Q5_1, after the fallback above.
  - **Alternative:** `ggml-org/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-GGUF` → `…-Q4_K_M.gguf` (20.88 GiB). It is smaller and has an audio-capable `mmproj`, but no importance matrix.

### 5.4 NVIDIA Nemotron Nano 9B v2 Reasoning (Intelligence Index 7)

- **What it is:** a dense hybrid Mamba-2/Transformer model.
  - 8.9B parameters.
  - 56 layers, of which only 4 are attention: 16 KiB per token of KV cache
    at f16.
  - Text only, 128k context, released August 2025.
  - [nvidia/NVIDIA-Nemotron-Nano-9B-v2](https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2).
- **The only shortlisted model that fits fully on this GPU,** at an
  estimated 5.6–5.7 GiB with a 32k context. That is tight.
- **Tool calls:** `<TOOLCALL>[…]</TOOLCALL>`, parsed natively. **Unmeasured
  on this machine.**
- **Reasoning** is switched only by `/think` or `/no_think` in a message. The
  template ignores the `enable_thinking` kwarg, so `--reasoning off` probably
  has no effect.
- **Licence: the NVIDIA Open Model License, with a guardrail clause.** It was
  checked verbatim at the
  [source](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/),
  §2.1, version 2025-10-24: bypassing or circumventing "any technical
  limitation, safety guardrail" without a substantially similar one means
  "your rights under this Agreement will automatically terminate". **An
  uncensored variant of this model therefore ends the licence to use it.**
- **Uncensored variants, for completeness:**
  - **Heretic:** [cpagac/Nemotron-Nano-9B-v2-heretic](https://huggingface.co/cpagac/Nemotron-Nano-9B-v2-heretic),
    KL 0.0191, 9 of 100 refusals against 94 of 100, made by an individual
    rather than p-e-w. GGUF: `mradermacher/Nemotron-Nano-9B-v2-heretic-i1-GGUF` → `Nemotron-Nano-9B-v2-heretic.i1-IQ4_NL.gguf` (4.94 GiB, verified).
  - huihui-ai's original repo is gone, and only mirrors remain.
- **Recommendation (base, because of the licence):** `bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF` → `nvidia_NVIDIA-Nemotron-Nano-9B-v2-IQ4_NL.gguf` (**4.94 GiB**, verified).
  - Unsloth publishes no GGUF of this model.
  - Its Q4_K_M is 6.08 GiB, which does not fit.
  - Serve it with `-ngl 99 -c 32768 -ctk q8_0 -ctv q8_0 -ub 256`. If it runs
    out of memory, use `-c 16384`.

### 5.5 Gemma 4 26B A4B Reasoning (Intelligence Index 17, estimated)

**What it is.** A mixture-of-experts model, 25.2B total and 3.8B active.
- Repo: [google/gemma-4-26B-A4B-it](https://huggingface.co/google/gemma-4-26B-A4B-it),
  released April 2026, Apache 2.0.
- 30 layers. 25 use a 1,024-token sliding window and 5 are global, so the KV
  cache is small: 10.6 KiB per token at q8_0, or 0.33 GiB at 32k.
- Text and image input, 256k context.

**Tool calls and reasoning.**
- Tool calls use Gemma's own `<|tool_call>call:…` format, which this build
  parses natively.
- Thinking is on or off only (`--reasoning on|off`), with no effort levels.

**Two cautions:**
- **A tool-grammar fix landed after this build:**
  [#29115](https://github.com/ggml-org/llama.cpp/pull/29115), on 2026-09-19.
- **The official chat template was revised on 2026-07-15.** Unsloth's GGUFs
  embed the current one. Other GGUFs embed older versions, so serve those
  with `--chat-template-file` pointing at
  [Google's](https://huggingface.co/google/gemma-4-26B-A4B-it/blob/main/chat_template.jinja).

**Quantization-aware training (QAT).** Google publishes QAT Q4_0 weights,
which it describes as "preserving similar quality to bfloat16", without a
number.

**Fit.**
- With `-ngl 99 --n-cpu-moe ~24 -c 32768 -fa on -ctk q8_0 -ctv q8_0`, about
  0.6 GiB of experts is read from RAM per token. That is the same traffic as
  the `qwen36` profile, which measured 7–8 tokens/s under WSL2.
- The nearest published figure is about 20 tokens/s on an 8 GB GTX 1080,
  from a llama.cpp fork **(single source)**.
- On the card it scores LiveCodeBench v6 77.1, AIME 2026 88.3 and
  τ²-bench 68.2.

**Uncensored variants.**
- [llmfan46 built a Heretic](https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-qat-q4_0-unquantized-uncensored-heretic)
  from the QAT checkpoint. It edits only `attn.o_proj`, so the experts are
  untouched QAT weights.
- It reports KL 0.0618, 11 of 100 refusals, and MMLU 80.66 → 80.39 against
  the QAT original. That is the smallest published capability cost of any
  26B variant.

**Recommendation:**
- **Uncensored:** `llmfan46/gemma-4-26B-A4B-it-qat-q4_0-uncensored-heretic-GGUF` → `gemma-4-26B-A4B-it-qat-q4_0-uncensored-heretic-Q4_0.gguf` (**14.93 GiB**, verified).
  - The edited attention projection is kept in BF16, which costs about 4 GPU
    expert layers. Use `--n-cpu-moe ~28`.
  - Serve it with Google's current template.
  - A leaner build of the same model is `mradermacher/gemma-4-26B-A4B-it-qat-q4_0-unquantized-uncensored-heretic-i1-GGUF` → `…i1-Q4_0.gguf` (13.49 GiB).
- **Base:** `unsloth/gemma-4-26B-A4B-it-qat-GGUF` → `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` (**13.27 GiB**, verified). It has the current template and an MTP drafter.

### 5.6 Gemma 4 12B Reasoning (Intelligence Index 14, estimated)

**What it is.** Dense, 12B, released June 2026, Apache 2.0.
- 48 layers: 40 use a sliding window, 8 are global.
- Text, image, audio and video input.

**Fit.** It fits fully only at about 3 bits: the 4-bit files are 6.2–6.9 GiB.

**Recommendation:**
- **Uncensored:** `mradermacher/gemma-4-12B-it-uncensored-heretic-i1-GGUF` → `gemma-4-12B-it-uncensored-heretic.i1-IQ3_XXS.gguf` (**4.52 GiB**, verified). Serve it with `-ngl 99 -c 16384 -ub 256 -fa on -ctk q8_0 -ctv q8_0`.
  - The source is llmfan46's Heretic: KL 0.1203, 6 of 100 refusals, MMLU
    76.17 → 73.02. That is a larger cost than the 26B's.
  - No KL is published at IQ3.
- **Base:** `unsloth/gemma-4-12b-it-GGUF` → `…UD-IQ3_XXS.gguf` (4.32 GiB).

**Versus the 26B.** The 26B with its experts in RAM is likely the better use
of this machine than a 3-bit 12B.

### 5.7 Gemma 4 E4B (not in the report, but it fits)

**What it is.** 4.5B effective parameters, 8B including the per-layer
embeddings, which llama.cpp keeps in system RAM.
- Repo: [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it),
  Apache 2.0.
- Text, image and audio input, 128k context.
- Artificial Analysis **measured** it at 8.9.

**Uncensored variants.** It has the best-documented uncensored build in this
document: [llmfan46's Heretic](https://huggingface.co/llmfan46/gemma-4-E4B-it-uncensored-heretic),
KL **0.0043**, 7 of 100 refusals, MMLU 69.46 → 68.97. Heretic's author
published his own E4B (KL 0.0072, but 42 of 100 refusals), with no GGUF.

**Recommendation:**
- **Uncensored:** `llmfan46/gemma-4-E4B-it-uncensored-heretic-GGUF` → `gemma-4-E4B-it-uncensored-heretic-Q6_K.gguf` (**5.79 GiB**, verified). About 3.6 GiB of it goes on the GPU, so a 64k context fits.
- **Base:** `unsloth/gemma-4-E4B-it-qat-GGUF` → `gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf` (**3.93 GiB**, verified).

### 5.8 gpt-oss-20b (Intelligence Index 10 at Low, estimated; 9 at High, measured)

**What it is.** A mixture-of-experts model, 21B total and 3.6B active.
- Repo: [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b),
  August 2025, Apache 2.0.
- 24 layers alternating a 128-token window and full attention.
- Text only, 131k context.
- The experts were **trained in MXFP4**, and OpenAI ran every evaluation at
  that precision. So the native MXFP4 file is the quantization: unsloth's
  "Q4_K_M" still has MXFP4 experts, and only its attention weights differ.

**Tool calls and reasoning.**
- Tool calls use the harmony format, which this build parses natively.
- Reasoning is set with `--reasoning-effort low|medium|high`, and cannot be
  fully switched off.
- **The report's "Low" is an estimate.** Measured at High, Artificial Analysis
  shows LiveCodeBench 0.777, AIME25 0.893 and **τ² 0.602**. That is the
  highest agentic tool-use score of any model in this document. Prefer
  medium or high effort.

**Uncensored variants.** From Heretic's author:
[p-e-w/gpt-oss-20b-heretic-ara-v3](https://huggingface.co/p-e-w/gpt-oss-20b-heretic-ara-v3),
KL 0.0554 and 3 of 100 refusals. Its weights were re-saved as MXFP4.

**Recommendation:**
- **Uncensored:** `mradermacher/gpt-oss-20b-heretic-ara-v3-GGUF` → `gpt-oss-20b-heretic-ara-v3.MXFP4_MOE.gguf` (**11.28 GiB**, verified).
  - Avoid the same repo's Q4_K_M, which is *larger*, at 14.72 GiB.
- **Base:** `ggml-org/gpt-oss-20b-GGUF` → `gpt-oss-20b-MXFP4.gguf` (**11.28 GiB**, verified).
- **Serve either with:** `-ngl 99 --n-cpu-moe ~18 -c 32768 -fa on -ctk q8_0 -ctv q8_0 --jinja --reasoning-effort medium --temp 1.0 --top-p 1.0`.
  - It reads about 0.84 GiB from RAM per token, so it is somewhat slower than
    the Gemma 26B.
- **Harness requirement:** the harness must send `reasoning_content` back in
  tool turns. The app's pipeline does.

### 5.9 Magistral Small 1.2 (Intelligence Index 9, estimated)

**What it is.** Dense, 24B, full attention on every layer. Repo:
[mistralai/Magistral-Small-2509](https://huggingface.co/mistralai/Magistral-Small-2509),
September 2025, Apache 2.0.

**Fit.** Its KV cache is the largest here: 85 KiB per token, so 2.66 GiB at
32k. Nothing fits, and offloaded it would run at an estimated low
single-digit tokens/s.

**Reasoning.** Thinking is switched by a system prompt, which the harness's
own system prompt would replace.

**Agentic score.** τ² 0.278 is the weakest of these models.

**Recommendation: skip.** If it is tried anyway:
- **Base:** `unsloth/Magistral-Small-2509-GGUF` → `…UD-IQ3_XXS.gguf` (8.76 GiB);
- **Uncensored:** `mradermacher/Magistral-Small-2509-ultra-uncensored-heretic-v1-i1-GGUF` (llmfan46, KL 0.0274).

---

## 6. The installed llama.cpp is older than it looks

Build 10597 was compiled on 2026-10-23, but its source commit `95b8e33e1`
is from **2026-08-23**. Upstream was past build 11800 by October.

**Fixes this build lacks:**

- Qwen3-Coder parser handling of nested arguments (#28742);
- a CUDA graph for the MTP draft (#28549);
- probabilistic MTP sampling (#27694);
- the Nemotron 3 pre-tokenizer fix (#30894).

**Against upgrading:** an open issue,
[#30906](https://github.com/ggml-org/llama.cpp/issues/30906), reports
repetition-loop output on the CPU backend for the Qwen3.8 family on build
11756. That matters for a partly offloaded `qwen38`.

**Recommendation:** keep 10597 until a newer build passes the `smoke` tier on
`qwen38`. Then rebuild, following `docs/guides/llama-cpp.md`, and record the
new build there. The `AGENTS.md` line "llama.cpp build 10597" is accurate,
but should also say the commit date.

## 7. Recommendations and next steps

**Recommended set.** File sizes are verified. "Unc." marks an uncensored
build. "VRAM" is where the weights sit: fully on the GPU, or with
experts/layers in RAM.

| Tier | Model | Recommended file | GiB | VRAM | Uncensored source and its published cost |
|---|---|---|---|---|---|
| 1 | Qwen3-4B-Instruct-2507 | `unsloth/Qwen3-4B-Instruct-2507-GGUF` → `Qwen3-4B-Instruct-2507-Q6_K.gguf` (**on disk**) | 3.08 | full | base; the only model measured end to end in harness mode |
| 1 | Gemma 4 E4B (unc.) | `llmfan46/gemma-4-E4B-it-uncensored-heretic-GGUF` → `…-Q6_K.gguf` | 5.79 | full (3.6 on GPU) | llmfan46 Heretic, KL 0.0043, MMLU −0.5 |
| 1 | Nemotron Nano 9B v2 | `bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF` → `…-IQ4_NL.gguf` | 4.94 | full, tight | base only: an uncensored build ends the NVIDIA licence |
| 2 | Gemma 4 26B A4B (unc.) | `llmfan46/gemma-4-26B-A4B-it-qat-q4_0-uncensored-heretic-GGUF` → `…-Q4_0.gguf` | 14.93 | experts in RAM, `--n-cpu-moe ~28` | llmfan46 Heretic on the QAT checkpoint, KL 0.0618, MMLU −0.27 |
| 2 | gpt-oss-20b (unc.) | `mradermacher/gpt-oss-20b-heretic-ara-v3-GGUF` → `…MXFP4_MOE.gguf` | 11.28 | experts in RAM, `--n-cpu-moe ~18` | p-e-w (Heretic's author), KL 0.0554, 3/100 refusals |
| 3 | Qwen3.8 27B (unc.) | `mradermacher/Qwen3.8-27B-heretic-ara-i1-GGUF` → `…i1-Q3_K_M.gguf` | 12.57 | layers in RAM, like `qwen38` | heretic-org, KL 0.0535, 0/100 refusals, MTP head kept |
| 3 | Qwen3.8 27B (base) | `unsloth/Qwen3.8-27B-GGUF` → `Qwen3.8-27B-UD-Q3_K_XL.gguf` (**on disk**) | 12.24 | layers in RAM | base; measured, tool calls work |

**Not recommended:**
- **Qwen3 Omni 30B A3B and Nemotron 3 Nano Omni:** only if audio or video
  input is wanted. Omni-Nemotron's uncensored builds are reported to lose a
  third of GPQA.
- **Magistral Small 1.2:** does not fit, and is weak on agentic tasks.
- **Gemma 4 12B at 3 bits:** the 26B is the better use of this machine.
- **`qwen25c` for the harness:** it cannot make structured tool calls.

**Test order.** Five downloads, 49.5 GiB in total. Each one needs the
owner's yes first.

1. **Settle section 4.** Decide which grading rule harness mode uses on
   code-writing benchmarks.
2. **gpt-oss-20b uncensored** (11.28 GiB). It has the strongest measured
   agentic score, and the most reputable uncensoring.
3. **Gemma 4 26B A4B uncensored** (14.93 GiB). It has the strongest card
   benchmarks among those that run at moderate speed here.
4. **Gemma 4 E4B uncensored** (5.79 GiB). The fast tier, to compare with
   Qwen3-4B-2507.
5. **Qwen3.8 27B heretic-ara** (12.57 GiB). It replaces or sits beside the
   current `qwen38`.
6. **Nemotron Nano 9B v2** (4.94 GiB). Only if a fully-GPU model stronger
   than the 4B ones is wanted.

**For each model:**
- add a serving profile (a `benchmark_profile` row) with its flags, and
  record them in the profile table in `AGENTS.md` and in
  `docs/guides/llama-cpp.md`;
- run `smoke` bare and through a model entry;
- record the results with their hardware, build and flags, as the
  maintenance policy requires.

**Before any of that:** decide whether to upgrade llama.cpp (section 6).
Gemma 4 especially benefits from the newer tool-grammar fix.

**Checks for the uncensored builds:**
- **Refusals in thinking mode.** One quantizer notes that abliteration
  targets the non-thinking answer **(single source)**. Check that refusals
  are also gone with thinking on.
- **Tool calls.** Check, through the harness, that structured tool calls
  still work. No uncensored build publishes this.
