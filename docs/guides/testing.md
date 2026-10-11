# Testing the app

Two different things get tested in this repo, and they use different tools:

- **The app itself** (backend, frontend, and the seam between them) is
  covered by the suites on this page, plus using it in the browser at
  `http://localhost:4000` (or the `make frontend` dev server on `:5174`).
- **Local serving configurations** are measured from the Benchmarks section's
  Tests, Compare and Report pages, against published benchmarks; see
  [benchmarks.md](benchmarks.md).

CI (`.github/workflows/ci.yml`) runs every suite below on every pull request,
and `main` requires its `CI passed` job.

## Running it all locally: `make check`

The root Makefile mirrors CI job for job, with the same commands:

| Target | CI job | What it runs |
|---|---|---|
| `make lint` | Lint and format (pre-commit) | `pre-commit run --all-files` (pinned to CI's pre-commit version) |
| `make test-backend` | Backend (pytest) | `uv lock --check`, `uv sync --frozen --group dev`, then pytest with a throwaway pgvector Postgres on `127.0.0.1:55432` (`LLLM_TEST_PG_PORT`), so `test_the_app_imports` runs instead of skipping |
| `make test-web` | Web (astro check, vitest, build) | `bunx astro check`, `bun run test:unit`, `bun run build` |
| `make test-e2e` | Web e2e (Playwright) | `bunx playwright test --workers=2` |
| `make test` | all three test jobs | the three above |
| `make check` | `CI passed` | `make lint`, then `make test` |

`make test-backend` removes its Postgres container on exit (Ctrl-C included)
and points `DATA_DIR` at a temp directory, so it never touches
`apps/server/data` or the `make backend` database. Stop `make frontend`
before `make test-e2e` (see below).

## Frontend (`apps/web`)

Run these from `apps/web/`:

- `bun run test:unit`: Vitest + React Testing Library (`src/**/*.test.tsx`).
- `bun run test:e2e`: Playwright (`e2e/`). It starts and stops its own dev
  server (`playwright.config.ts`'s `webServer`, with the same daemon
  workaround as `make frontend`, plus a `globalTeardown` that force-stops it
  afterward: a clean Playwright run was observed leaving the daemon alive
  despite the signal-based path, so this doesn't rely on that alone).
- `bunx astro check` for types (expect 0 errors).
- `bun run format` (Biome: formats, and applies safe lint fixes) and
  `bun run lint` (Biome, check only). The config is `biome.jsonc`. The repo's
  pre-commit hook runs Biome's formatter on every commit; until the existing
  lint findings are fixed it doesn't lint yet (see the root
  `.pre-commit-config.yaml`). If a commit is rejected because the hook
  reformatted a file, `git add` it and commit again.

**Run Playwright with `--workers=2`.** At its default worker count (half the
cores, about 10 on this 20-core machine) the cold `astro dev` server can't
answer that many browsers in time, and redirect assertions hit their 5 s
timeout. That fails on `main` too, so it isn't caused by any one change.
`bunx playwright test --workers=2` (CI's count) runs clean.

The e2e specs mock every `/api/v1/**` response and stub `/ws`, so they need
**no backend**, and they will fight a `make frontend` you already have
running: they reuse it if present, which is fine, and `global-teardown.ts`
stops it afterward, which is not. Stop `make frontend` first.

Because Playwright mocks the backend, a change that touches the
frontend/backend seam also needs a real run against `make backend`.

## Backend (`apps/server`)

From `apps/server/`:

```bash
LLLM_SECRET_KEY=<any long string> .venv/bin/python -m pytest tests
```

The package imports from the working directory, and refuses to load without
a secret key. pytest comes from `pyproject.toml`'s `dev` dependency group,
which `make backend`'s `uv sync` installs by default.

One test, `test_imports.py::test_the_app_imports`, imports the whole app,
which connects the default vector store (pgvector) and runs migrations. It
needs `TEST_DATABASE_URL` pointing at a **throwaway** Postgres with pgvector,
never the `make backend` database:

```bash
docker run --rm -d -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=local_llm -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=local_llm \
  pgvector/pgvector:pg16
TEST_DATABASE_URL=postgresql://local_llm:throwaway@127.0.0.1:55432/local_llm
```

Without it the test skips locally; CI provides one and fails rather than
skips.

`tests/test_serving_fingerprint.py` is the guard on the serving fingerprint:
it checks `serving/fingerprint.py` against the golden values in
`docs/serving-baseline/`. A drifting fingerprint does not raise at runtime;
it silently files a configuration under a new id, so run it after any change
to the serving layer.

## Lint and format

`.pre-commit-config.yaml` at the repo root is the only definition of the lint
and format checks; CI runs the same file with `--all-files`. Install it once
with `uv tool install pre-commit && pre-commit install` (and `bun install` in
`apps/web`, since the Biome hook runs that copy), or run it by hand with
`pre-commit run --all-files`.
