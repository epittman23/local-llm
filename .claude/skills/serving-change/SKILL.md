---
name: serving-change
description: Change how llama-server is launched or what a serving profile means (a flag, a default, a profile field) without silently breaking the config_id fingerprint. Use for any edit to benchmarks/serving/launcher.py, profiles.py or fingerprint.py, or to a profile's settings.
---

# serving-change

The rules are in `AGENTS.md` ("Local inference", "Conventions" and the
"Code and docs must agree" and schema bullets of "Maintenance policy"), and
the hazard is spelled out in the docstring of
`apps/server/local_llm/benchmarks/serving/fingerprint.py`. Read both first.
The short version: every benchmark row is keyed by `config_id`, and a wrong
fingerprint raises nothing. It just files the same configuration under a new
id, or two configurations under one.

## Decide what the change is

- **It changes what the server computes** (a new flag, a changed default,
  a new profile field): it must be in `config_lines()`, so different
  configurations get different ids.
- **It only changes what the server reports** (like `--metrics`, `-lv`):
  keep it out of the hash, and say so in the fingerprint docstring.
- **It changes the format of an existing line** (separator, spelling,
  order): avoid it. If it is unavoidable, it changes every id and is treated
  like the next case.

## Every place a launch-flag change touches

1. `serving/launcher.py` `build_argv()`: the flag itself.
2. `serving/fingerprint.py` `config_lines()`: the line that records it,
   unless it is excluded on purpose (above).
3. `benchmarks/analysis/stats.py` `parse_config_text()`: if a new line
   should become a typed column.
4. `apps/server/tests/test_launcher.py` and `test_serving_fingerprint.py`:
   tests for the new behaviour.
5. If every existing `config_id` changes: a **new** Alembic revision that
   inserts a `benchmark_schema_note` row (use the `new-migration` skill;
   `f4b6d2e8a913` is the model), plus a new capture in
   `docs/serving-baseline/` as #127 did with `fingerprints-v2.json`.
   A new capture file passes the PR gate, but editing or removing an
   existing file there trips its golden-file rule, which needs a
   `## Gate changes` entry and the owner's approval (use the `pr-gate`
   skill). Never rewrite an existing capture to make a test pass.
6. Docs: AGENTS.md "Local inference" (and the profile table if a profile
   changed), `docs/guides/llama-cpp.md`, and a `docs/decisions.md` entry
   (use the `docs-sync` skill).

## Verify

The same environment `make test-backend` uses, without its Postgres, which
these tests do not need:

```sh
cd apps/server
export UV_PROJECT_ENVIRONMENT="$PWD/.venv"
uv sync --frozen --no-install-project --group dev
LLLM_SECRET_KEY=test-only-not-a-secret-0123456789abcdef0123456789abcdef \
  uv run --frozen python -m pytest -q \
  tests/test_serving_fingerprint.py tests/test_launcher.py tests/test_serving_profiles.py
```

Then confirm the frozen cases still hold. The six shell lines and the 24
shell captures in `fingerprints.json` must keep matching unless the change
deliberately alters one, and the collision invariants must still collide.
A real serve from Benchmarks > Serve is the only end-to-end check. It needs
the GPU, so ask the owner before starting one.
