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

## Template
```
hf download < model > --local-dir ~/models/< alias > --include "*< quant >*"
```
---
## Qwen 3.6 35B A3B (`qwen36`)
```
hf download unsloth/Qwen3.6-35B-A3B-GGUF --local-dir ~/models/qwen36-35b-a3b --include "*UD-Q4_K_XL*"
```

## Qwen 3.8 27B (`qwen38`)
```
hf download unsloth/Qwen3.8-27B-GGUF --local-dir ~/models/qwen38-27b --include "*UD-Q3_K_XL*"
```

## Qwen 2.5 Coder 7B (`qwen25c`)
```
hf download unsloth/Qwen2.5-Coder-7B-Instruct-GGUF --local-dir ~/models/qwen25-coder-7b --include "*Q4_K_M*"
```

## Qwen 3 Coder 30B A3B (`qwen3c`)
```
hf download unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF --local-dir ~/models/qwen3-coder-30b-a3b --include "*Q4_1*"
```