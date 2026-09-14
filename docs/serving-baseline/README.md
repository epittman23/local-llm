# Serving-layer baseline

Captured **2026-09-14** from `scripts/shell/main.sh`, immediately before
the shell layer is ported to Python and the serving profiles move into
Postgres.

This directory is not documentation in the usual sense: it is **test
input**. It exists so that the bash-to-Python port can be proven faithful
rather than merely believed to be.

## Why this exists

`config_id` is an 8-character fingerprint of a serving configuration,
computed today by `_vramlog_config` in `scripts/shell/vram-log.sh:122-153`.
Every row in the `benchmark_*` Postgres tables is keyed by it, and
`benchmarks/stats.py:parse_config_text` parses the six fingerprinted
lines back into typed columns.

That means a single character of drift in the Python port does not raise
an error. It silently files the same serving configuration under a new
id, so historical measurements stop comparing against new ones and the
Compare and Report pages quietly answer the wrong question. There is no
automated test suite here to catch it, so these captured values are the
safety net.

## Files

| File | What it is |
|---|---|
| `fingerprints.json` | 24 `config-id` captures: four profile baselines plus every override branch, with the resulting `config_id`, `alias` and all six config lines verbatim. |
| `profiles.json` | The four profiles' resolved settings, as seed data for the `benchmark_profile_version` table. |
| `profile-rationale.txt` | The verbatim source slices from `main.sh` carrying each profile's rationale comments. |

## `fingerprints.json`

Each entry records the case name, the profile, the environment overrides
applied, and the resulting fingerprint. The `note` field on each case
names the branch of `_lllm_profile` / `_vramlog_config` that case exists
to pin.

The `invariants` block is the part with real assertive power. Four cases
are expected to **collide** with another case, and each collision encodes
behaviour that is easy to lose in a port:

| Invariant | Cases | Why it matters |
|---|---|---|
| `spec-empty-is-off` | `spec-off` ≡ `spec-empty` | An empty `LLAMA_SPEC` is treated as off, not as an empty flag list rendered some other way. |
| `reasoning-noop-on-non-thinking-model` | `base-qwen36` ≡ `reasoning-noop` | `LLAMA_REASONING` is ignored unless the profile carries `reasoning_effort` in `EXTRA`. A non-thinking model reported as reasoning "medium" would mean a caller setting a knob the server ignores. |
| `moe-flag-dropped-on-dense` | `base-qwen38` ≡ `moe-on-dense` | The `main.sh:239-243` guard rail: an MoE-only flag must never reach a dense model. |
| `model-path-not-fingerprinted` | `base-qwen38` ≡ `invariant-model-path` | The fingerprint covers the *served configuration* only. Changing the weights path is a new profile version but the same `config_id`. |

A port that passes the 24 individual fingerprints but breaks an invariant
has almost certainly hard-coded its way to the right answers.

## `profiles.json`

Two deliberate differences from what `lllm-profile-json` emits:

1. **`model_path` is templated**, not absolute. It carries the literal
   string `{LLAMA_MODELS}` where the shell would have interpolated
   `$LLAMA_MODELS` (which defaults to `$HOME/models`). The capture ran in
   a container whose `$HOME` is not the target machine's, so an absolute
   path here would have been wrong. Resolve the placeholder at seed time.
2. **`hf_repo` and `hf_pattern` are included.** `lllm-profile-json` does
   not emit `LLAMA_P_REPO` or `LLAMA_P_PATTERN` at all — they are only
   read by `lllm-fetch`. They are recovered here directly from
   `_lllm_profile`, because the weights-download feature needs them.

`weights_present` is deliberately **not** carried over: it is an
observation about a filesystem, not part of a profile's definition.

Profile order is `main.sh:70`'s `LLAMA_PROFILE_NAMES`
(`qwen38 qwen36 qwen25c qwen3c`), which is the order diagnostics list
them in. The default profile is `qwen38` (`main.sh:53`).

## `profile-rationale.txt`

Verbatim `sed` slices of `main.sh`, not a paraphrase — these comments
record *measured* values and the reasoning behind them, and they are the
single most valuable content in the file. Examples: why `qwen38` runs at
`-ngl 20` rather than 99; why `moe=34` is the measured optimum on 6 GB of
VRAM; the KV-cache arithmetic (~29.7 KiB/token) behind `qwen25c` serving
16K instead of the model's full 32K; and why `--parallel` is always
passed explicitly rather than left at llama.cpp's `-1` auto default,
which silently switches on `kv_unified` and four slots and was measured
at 15.63 vs 26.38 t/s prefill.

Three shared blocks are included alongside the per-profile ones, since
they explain table-level decisions rather than any single profile:
`SHARED-arch`, `SHARED-parallel`, `SHARED-cache`.

These become the `notes` field on each seeded profile version, rendered
in the Benchmarks Serve page. Moving them out of bash comments and into
something visible is most of the point of putting profiles in the
database.

## How the port consumes this

`fingerprints.json` becomes a committed test that feeds the ported
`fingerprint.py` **from the seeded profile rows**, not from hand-written
fixtures. That way the same test also covers the seed migration: a typo
in the seed data surfaces immediately as a fingerprint mismatch, rather
than as quietly wrong serving flags months later.

Once that test is green, this directory has done its job. Keep it: it is
also the record of what the shell layer meant.
