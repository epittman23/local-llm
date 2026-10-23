# Log fixtures for `src/progress.test.ts`

Output of the root Makefile's `make backend`, as the desktop app's log file
receives it. Captured from real runs on 2026-10-23 (Fedora 44, uvicorn 0.54),
with the home directory replaced by `/home/user`. Kept byte for byte (Biome
skips this directory), because the markers are matched in exactly this form.

- `start.log`: a warm start (environment already synced), up to the first
  `/ready` that returned 200.
- `shutdown-idle.log`: after one SIGINT, with nothing served or running.
- `shutdown-stalled-request.log`: after one SIGINT, with a request held
  open; uvicorn cancels it at the 10 s graceful timeout.
- `failed-start.log`: `make backend` with no `infra/.env`.
- `shutdown-with-jobs.synthetic.log`: **not captured**. It is
  `shutdown-idle.log` preceded by the four marker lines the backend's
  shutdown hook logs (`routers/benchmarks/__init__.py`, `serve.py`) in the
  backend's own log format. llama.cpp was not built on the machine, so a run
  with a served model could not be captured. Replace it with a real capture
  once one can be made.
