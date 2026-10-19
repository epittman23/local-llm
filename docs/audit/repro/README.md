# Audit reproductions

Minimal reproductions for findings in [../FINDINGS.md](../FINDINGS.md), at
commit `7a4088b`. None of them changes the repository or needs Postgres.

Python ones run from `apps/server` with the backend venv:

```
cd apps/server
LLLM_SECRET_KEY=x0123456789abcdef0123456789abcdef DATA_DIR=$(mktemp -d) PYTHONPATH=. \
  .venv/bin/python ../../docs/audit/repro/<script>.py
```

The `u3/` scripts also need their own directory on the path (they import
`stub.py`, which stubs the DB model imports):
`PYTHONPATH=.:../../docs/audit/repro/u3`.

| Script | Finding | Expected output on the audited commit |
|---|---|---|
| `u1_fingerprint_extra.py` | A-02 | three identical config ids; `False False` (argvs differ) |
| `u2_grade_exit.py` | A-01 | wrong answers graded `('pass', '')` |
| `u2_grade_main_input.py` | A-01 | a correct answer graded `fail_error` (EOF) or `fail_timeout` (terminal stdin) |
| `u2_loop_block.py` | A-15 | max gap between 100 ms ticks of about 3 s |
| `u3/headline.py` | A-03 | section 4 says a contrast survives; the headline says no prompt differs |
| `u3/fa.py` | A-06 | `differing: []` for configs that differ only in `fa` |
| `u3/baseline.py` | A-07 | `B full ... vs None different tier` although `A full` exists |
| `u4_tune.py` | A-09, A-10, A-11, A-12 | survivors exclude the tied candidate; `best()` returns a slower candidate; zipped diffs all 0; cooldown total 0.8 after 3000 s |
| `u6_frontend_recipe.mk` | A-20 | `make -f u6_frontend_recipe.mk` starts "the server" after the install step fails, without the trap |
| `u7_humanize_header.js` | A-04 | `node u7_humanize_header.js` throws `col.replace is not a function` |
| `u9/norm.test.ts` | A-25 | from `u9/`: `bun test --preload ./pre.ts ./norm.test.ts` passes, showing a non-current reply stays `done: false` |
| `u10_automation_rrule.test.ts` | A-34 | copy into `apps/web/src/`, fix the import to `./routes/automations/automationModel`, `bunx vitest run`; logs each rule rewritten (`BYDAY=1MO` → `BYMONTHDAY=1`, `9,17` → `9`, `UNTIL` dropped) |
| `u9_chatfiles.test.ts` | A-35 | copy into `apps/web/src/` with imports rewritten to `./lib/chat/...`, `bunx vitest run`: passes, showing a file not on the conversation path is still sent |
