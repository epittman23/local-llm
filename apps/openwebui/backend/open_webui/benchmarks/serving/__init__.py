"""benchmarks/serving - the serving layer, ported from local-llm's shell scripts.

Until 2026-09-14 the serving profiles and the configuration fingerprint lived
in bash (scripts/shell/main.sh's `_lllm_profile`, scripts/shell/vram-log.sh's
`_vramlog_config`), and this app shelled back out to them to read a profile or
to start a server. This package is that logic in Python.

Deliberately storage-agnostic: `profiles` defines the data shape and the
override/guard-rail resolution, and `fingerprint` derives the config text and
its id. Where a profile's fields come from -- seed data, a Postgres row, a
test fixture -- is somebody else's problem, which is what lets the fingerprint
be tested against `docs/serving-baseline/` without a database.
"""
