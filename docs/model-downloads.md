# Model Download Commands

The manual replacement for the deleted `lllm-fetch` shell command (Phase 2c
of the migration, 2026-09-18): there is no "download weights" action in the
Serve page yet (planned for Phase 5 — see `docs/migration-plan.md`), so
until then, weights for a profile not already on disk are fetched by hand
with these `hf` CLI commands, one per profile in `LLAMA_PROFILE_NAMES`'
former order. Repo, quant pattern and local dir come from
`docs/serving-baseline/profiles.json` / `serving/profiles.py`, the single
source of truth for profile definitions now that the shell case statement is
gone.

These are the four profiles the seed migration
(`migrations/versions/5a1f0c3e9b27_add_benchmark_serving_profiles.py`)
creates. A profile created later from the Serve page lives only in Postgres;
its command is the template below filled in from that profile's `hf_repo`,
`hf_pattern` and `model_path` directory.

## Template
```
hf download < model > --local-dir ~/models/< alias > --include "*< quant >*"
```

`~/models` is the default for `LLAMA_MODELS`, the directory
`serving/launcher.py`'s `resolve_model_path()` substitutes into a profile's
`{LLAMA_MODELS}/...` path. If `LLAMA_MODELS` is set to somewhere else,
download there instead, or the Serve page will not find the file.

---
## Every profile
All four downloads in one go, into `LLAMA_MODELS` (default `~/models`). The
three sizes recorded in `docs/CLAUDE.md` alone come to about 43 GiB
(`qwen36` 20.81, `qwen3c` 17.87, `qwen25c` 4.36); `qwen38` comes on top of
that.
```
M="${LLAMA_MODELS:-$HOME/models}"
hf download unsloth/Qwen3.8-27B-GGUF --local-dir "$M/qwen38-27b" --include "*UD-Q3_K_XL*"
hf download unsloth/Qwen3.6-35B-A3B-GGUF --local-dir "$M/qwen36-35b-a3b" --include "*UD-Q4_K_XL*"
hf download unsloth/Qwen2.5-Coder-7B-Instruct-GGUF --local-dir "$M/qwen25-coder-7b" --include "*Q4_K_M*"
hf download unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF --local-dir "$M/qwen3-coder-30b-a3b" --include "*Q4_1*"
```

## Qwen 3.8 27B (`qwen38`)
```
hf download unsloth/Qwen3.8-27B-GGUF --local-dir ~/models/qwen38-27b --include "*UD-Q3_K_XL*"
```

## Qwen 3.6 35B A3B (`qwen36`)
```
hf download unsloth/Qwen3.6-35B-A3B-GGUF --local-dir ~/models/qwen36-35b-a3b --include "*UD-Q4_K_XL*"
```

## Qwen 2.5 Coder 7B (`qwen25c`)
```
hf download unsloth/Qwen2.5-Coder-7B-Instruct-GGUF --local-dir ~/models/qwen25-coder-7b --include "*Q4_K_M*"
```

## Qwen 3 Coder 30B A3B (`qwen3c`)
```
hf download unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF --local-dir ~/models/qwen3-coder-30b-a3b --include "*Q4_1*"
```
