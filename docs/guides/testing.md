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
| `make secrets` | Secrets (gitleaks) | gitleaks over the whole git history (CI scans a pull request's own commits, and main's whole history) |
| `make test-types` | Backend types (basedpyright) | basedpyright over `apps/server/local_llm`, against `basedpyright-baseline.json` |
| `make test-backend` | Backend (pytest) | `uv lock --check`, `uv sync --frozen --group dev`, then pytest with coverage and a throwaway pgvector Postgres on `127.0.0.1:55432` (`LLLM_TEST_PG_PORT`), so `test_the_app_imports` runs instead of skipping; then diff-cover on the changed lines |
| `make test-web` | Web (astro check, vitest, build) | `bunx astro check`, `bun run test:coverage` and diff-cover on the changed lines, `bun run build` |
| `make test-e2e` | Web e2e (Playwright) | `bunx playwright test --workers=2` |
| `make test-desktop` | Desktop (typecheck, vitest, package smoke) | `bun run typecheck`, `bun run test:unit`, `bun run package:dir` (an unpacked package, no `.rpm`) |
| `make test-boot` | Boot (real stack) | builds `apps/web`, then `tests/boot_smoke.py` against a throwaway Postgres (`:55433`) and Redis (`:56379`) |
| `make test` | all six test jobs | the six above |
| `make check` | `CI passed` | `make lint`, `make secrets`, then `make test` |

`make test-backend` removes its Postgres container on exit (Ctrl-C included),
so it never touches the `make backend` database. Any pytest run, `make` or
not, points `DATA_DIR` at a temp directory (`tests/conftest.py`), so it
never touches `apps/server/data`. Stop `make frontend`
before `make test-e2e` (see below).

## Baselines for inherited findings

Two checks found too many problems in inherited code to fix before turning
them on:

- basedpyright, in standard mode, over the backend (`make test-types`, CI's
  Backend types job): 2,247 findings on 2026-10-23;
- Biome's linter over `apps/web` (a pre-commit hook): 754 findings.

Each runs against a committed baseline, `apps/server/basedpyright-baseline.json`
and `apps/web/biome-baseline.json`. A baseline records how many findings of
each rule each file may have. `.github/scripts/lint_ratchet.py` fails if any
file has more than its baseline allows, and lists the findings in that file
and rule, the new ones among them. So new code meets the full rule set, and
old code can't get worse.

**Baselines only shrink.**

1. Fix some findings.
2. Run `make baselines`. It writes the lower counts, and refuses if anything
   grew.
3. Commit the smaller file.

The PR gate lets a baseline shrink without approval, and trips on one that
grows, is added or is removed. `tests/fixtures/schema_drift.json` follows
the same rule.

The baselines are a rollout stage, and the aim is zero. Once a baseline is
empty, its tool runs without one. Then Biome's hook becomes
`biome check --error-on-warnings`, and basedpyright just fails on any
finding.

basedpyright's version is pinned in `ci.yml` and the Makefile
(`BASEDPYRIGHT_VERSION`), outside Dependabot. A new version can change what
it reports, so bump it by hand and run `make baselines`.

## Coverage of the changed lines

The backend and web jobs measure coverage: pytest-cov for `local_llm`, and
Vitest's v8 provider for `apps/web/src`. On a pull request they then run
[diff-cover](https://github.com/Bachmann1234/diff_cover) against the PR's
base commit.

- **The rule.** At least **80%** of the lines the PR adds or changes, and
  that coverage can measure, must run under the unit tests. The setting is
  `DIFF_COVER_FAIL_UNDER` in `ci.yml` and the Makefile.
- **Why changed lines.** Nothing gates the overall figure (backend about
  42%, web about 45% on 2026-10-23). The bar applies only to what a PR
  touches, so new code arrives with tests and old code gains them as it
  changes.
- **Calibration.** Recent PRs that shipped with tests scored 81% (#367),
  84% (#374), 94% (#371) and 100% (#375). #368, a small change at seven
  call sites in hooks that only Playwright exercises, scored 56% and would
  have needed unit tests for those hooks.
- **Locally.** `make test-backend` and `make test-web` run the same check
  against `DIFF_BASE`, which defaults to `origin/main`. On a stacked branch
  that includes the parent PRs' lines too.
- **Excluded from measurement.** Coverage does not measure:
  - applied migrations, which run in subprocesses coverage doesn't follow;
  - shadcn/ui's generated components;
  - the desktop app, whose Electron glue Vitest can't run.
- **No ignore comments.** A `# pragma: no cover` or `v8 ignore` comment
  trips the PR gate. Write the test instead.

## The PR gate and the tripwire

Besides `CI passed`, every pull request gets a **`PR gate`** check
(`.github/workflows/pr-gate.yml`). It checks three things:

- **Title.** The PR title must be a conventional commit, since the squash
  merge uses it as the commit subject.
- **Attribution.** No attribution line may appear in the title, the body or
  any commit (AGENTS.md's commit policy).
- **Tripwire.** It looks for changes that weaken CI:
  - edits to a gate file;
  - new skips or suppressions;
  - deleted or fewer tests;
  - coverage-ignore comments;
  - a grown baseline of inherited findings;
  - edited golden files;
  - edits to append-only files.

  The full list is in AGENTS.md, "The CI tripwire", and the patterns are in
  `.github/scripts/pr_gate.py`.

> **No agent may ever bypass the tripwire without first asking the owner for
> explicit permission and giving explicit reasoning for the bypass.** See
> AGENTS.md for what counts as a bypass and what to do when it trips.

The owner approves a tripping PR with **both** of these:

- the `gate-change-approved` label, applied after the latest push (a push
  removes it);
- a `## Gate changes` section in the PR body that explains each finding.

The workflow runs under `pull_request_target`. That means **main's** copy of
the workflow and script judges every PR, and a PR that edits either one is
judged by the version it is changing. Nothing from the PR is checked out or
run. The script reads the diff through the API.

Two consequences:

- **A change to the gate merges unexercised.** Its unit tests
  (`.github/scripts/test_pr_gate.py`, run by `make lint`) are its only check
  before then.
- **Test a gate change against real PRs before opening it.** Run
  `make pr-gate PR=<n>` (read-only, using `gh auth token`) on a few:
  - one that should trip, such as a CI change;
  - one that should pass, such as docs or a Dependabot bump.

## Merging: auto-merge and branch updates

Since 2026-10-24, a pull request merges itself once it is green. Nobody
reviews PRs before they merge, so a PR that should wait must be held back
on purpose.

- **Which PRs.** Every PR from a branch of this repository that is not a
  draft, when it is opened, reopened or marked ready for review
  (`auto-merge.yml`). Forks never qualify. Dependabot's PRs keep their own
  rule (`dependabot-automerge.yml`: everything but major bumps).
- **When.** GitHub squash-merges once the main ruleset's required checks
  (`CI passed`, `PR gate`, CodeQL) pass on a branch that is up to date with
  `main`. A gated PR waits, because `PR gate` fails until the owner adds
  `gate-change-approved`. With auto-merge on, that label is the merge
  button: adding it to a green, up-to-date PR merges it.
- **Holding a PR back.** Open it as a draft, or turn auto-merge off on the
  PR page. Later pushes do not turn auto-merge back on; only reopening or
  marking it ready for review does.
- **Branch updates.** The ruleset requires a branch to be up to date, so
  `update-branches.yml` merges `main` into each auto-merge PR that is
  behind: on every push to `main`, every 30 minutes, and on demand
  (Actions > Auto-merge and branch updates > Run workflow). It uses a merge
  commit, never a rebase or a force-push, and CI runs on the result. A PR
  with a conflict is skipped with a warning and needs a hand merge.
  Dependabot's PRs are left to Dependabot, which rebases them itself.
- **An update removes an approval.** An update is a new commit, so
  `pr-gate.yml` removes `gate-change-approved` from a gated PR it updates,
  and the owner approves again (one approval per commit). Approve a gated
  PR when it is up to date.
- **After a Dependabot merge.** Those merges use `GITHUB_TOKEN`, so they
  start no workflow, and other PRs are updated on the next half-hourly run.

### The `AUTOMERGE_TOKEN` secret

Both jobs in `update-branches.yml` act with the owner's token, not
`GITHUB_TOKEN`. GitHub starts no workflow for anything done with
`GITHUB_TOKEN`, so an update pushed with it would get no CI, and the
required checks would never report. The token lives only in
`update-branches.yml`, which runs main's copy on every trigger.
`auto-merge.yml` runs the PR's own copy, holds no secret, and only names
the PR. The token job re-reads the PR and refuses forks, drafts, closed
PRs and Dependabot.

To create it (GitHub > Settings > Developer settings > Fine-grained tokens):

1. Repository access: only `epittman23/local-llm`.
2. Repository permissions: **Contents**, **Pull requests** and
   **Workflows**, each read and write. Workflows is probably needed only
   when an update merges a workflow change from `main` into a PR branch.
3. An expiry date; note it.
4. Save it as the Actions secret `AUTOMERGE_TOKEN` (repository Settings >
   Secrets and variables > Actions).

Without the secret, both jobs warn and do nothing. With a token GitHub
rejects, for example an expired one, the run fails. Renew it before it
expires.

## Frontend (`apps/web`)

Run these from `apps/web/`:

- `bun run test:unit`: Vitest + React Testing Library (`src/**/*.test.tsx`).
- `bun run test:e2e`: Playwright (`e2e/`). It starts and stops its own dev
  server (`playwright.config.ts`'s `webServer`, with the same daemon
  workaround as `make frontend`, plus a `globalTeardown` that force-stops it
  afterward: a clean Playwright run was observed leaving the daemon alive
  despite the signal-based path, so this doesn't rely on that alone).
  The dev server writes only to `apps/web/.astro/dev.log`, which Playwright
  never prints. When the e2e job fails in CI, it prints that log's last 200
  lines and uploads the whole file with the `playwright-test-results`
  artifact, so a dev server that dies mid-run leaves its reason behind.
- `bunx astro check` for types (expect 0 errors).
- `bun run format` (Biome: formats, and applies safe lint fixes) and
  `bun run lint` (Biome, check only). The config is `biome.jsonc`. The repo's
  pre-commit hooks run Biome's formatter on every commit, and its linter
  against `biome-baseline.json`: the findings inherited from upstream are
  allowed, and a new one fails (see "Baselines for inherited findings"
  below). If a commit is rejected because the hook reformatted a file,
  `git add` it and commit again.

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
`tests/test_frontend_contract.py` (backend pytest) covers one part of that
seam automatically: every `fetch()` in `apps/web/src` must match a route
the backend serves, by method and path. The mocks follow the frontend, so
without that check a renamed or removed backend route would leave both
suites green.

## Desktop (`apps/desktop`)

Run these from `apps/desktop/`:

- `bun run test:unit`: Vitest. It covers the settings (`config.ts`), what
  the window may open (`policy.ts`), the start decisions and the stop
  sequence (`stack.ts`, with the process calls faked), and the progress
  dialog (`progress.ts`). The dialog's tests replay logs captured from real
  `make backend` runs (`test/fixtures/`, whose README says which one is not
  captured).
- `bun run typecheck`, and `bun run lint` / `bun run format` (Biome; the
  pre-commit hook lints this app too, not only formats it).
- `bun run package:dir`: the unpacked package CI builds.

Launching and stopping the real stack has no automated suite, since it needs
Docker and a display. Check it by hand when `src/main.ts` or `src/stack.ts`
change:

1. **Nothing running:** `make desktop`. The dialog ticks through every
   startup step, and the app opens at `http://127.0.0.1:4000`.
2. **Close it.** The dialog shows the shutdown steps. Afterwards
   `pgrep -a -x make` and `docker compose -f infra/docker-compose.yml ps`
   are empty. With a model served from Benchmarks > Serve and its log
   open, "Stop the served model" runs, and `pgrep -a llama-server` is empty
   too.
3. **Attach:** start `make backend` in a terminal, then the app. It opens
   with no build. After closing it, the terminal backend still runs.
4. **Recovery:** `kill -9` the app while it owns the stack, then start it
   again. It adopts the stack, and closing it stops everything.
5. **Cancel** mid-startup: nothing is left running.

On 2026-10-23 steps 1 to 5 were run this way, with Playwright's Electron
driver, against a real stack (no model served: llama.cpp was not built).

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

`tests/test_schema_drift.py` also needs `TEST_DATABASE_URL`. It migrates
a fresh database on that server, then compares every SQLAlchemy model
against the result with Alembic's autogenerate. Without it, a model change
with no migration passes every other test and then fails against the real
database. The comparison is checked against
`tests/fixtures/schema_drift.json`, which lists the 108 differences
inherited from upstream when the check was added on 2026-10-23. Any new
difference fails. The file may only shrink:

1. Fix a model to match its migration, or add a migration.
2. Record the smaller list with `SCHEMA_DRIFT_RECORD=1`.
3. Commit the smaller file. The PR gate lets it shrink without approval
   and trips if it grows (`SHRINK_ONLY` in `.github/scripts/pr_gate.py`),
   as with the baselines above.

`tests/test_prescreen_optuna_schema.py` needs `TEST_DATABASE_URL` too. It
migrates a fresh database, runs Optuna studies through the pre-screen's
storage, forces an Optuna schema upgrade, and checks that `public` (and its
`alembic_version`) never sees any of it. It also starts the real
optuna-dashboard process and checks that it listens on loopback only. The
rest of the pre-screen's tests need no database: they run fake
`llama-bench`, `llama-server` and `nvidia-smi` scripts
(`tests/prescreen_stubs.py`) as real subprocesses, so nothing loads a
model.

`tests/test_frontend_contract.py` reads every `fetch(...)` in
`apps/web/src` (tests excluded) whose URL is a template on one of the base
paths in `lib/constants.ts`. It checks each call's method and path against
the app's route table. A URL segment taken from a helper's parameter, such
as `testsRequest(token, 'datasets')`, is checked once per literal the
helper is called with. Calls it cannot resolve are mostly terminal servers
and direct OpenAI connections. It counts them, and fails if the count grows
past `UNRESOLVED_LIMIT` (38 on 2026-10-23). It checks paths and methods
only, not request or response bodies.

## Boot smoke: the real backend, started and used

`tests/boot_smoke.py` (`make test-boot`, CI's Boot job) starts the backend
the way `make backend` does: uvicorn, Postgres with pgvector, Redis,
migrations on an empty database and the built frontend. A stub
OpenAI-compatible server stands in for OpenRouter, so no request leaves
the machine. The smoke then uses the running backend:

1. Waits for `/ready`.
2. Signs up the first user (the admin) and signs in.
3. Gets a chat completion back from the stub.
4. Calls every GET route that takes no path parameter, failing on any 5xx.
5. Checks that the API refuses a request without a token.
6. Stops it with SIGINT and expects a clean exit.

Nothing else in CI starts the app: pytest imports it, and Playwright mocks
it. `SWEEP_SKIP` in the script lists the routes the sweep leaves out, each
with its reason. On failure the script prints the end of the backend's log.

`tests/test_serving_fingerprint.py` is the guard on the serving fingerprint:
it checks `serving/fingerprint.py` against the golden values in
`docs/serving-baseline/`. A drifting fingerprint does not raise at runtime;
it silently files a configuration under a new id, so run it after any change
to the serving layer.

## Lint and format

`.pre-commit-config.yaml` at the repo root is the only definition of the lint
and format checks; CI runs the same file with `--all-files`. Install it once
with `uv tool install pre-commit && pre-commit install` (and `bun install` in
`apps/web` and `apps/desktop`, since each Biome hook runs that app's copy), or run it by hand with
`pre-commit run --all-files`.

Generated code is not linted or formatted:

- `apps/server/local_llm/migrations/versions/`: Alembic revisions, which are
  also never edited once applied. Excluded in `apps/server/pyproject.toml`
  with `force-exclude`. That holds under pre-commit, CI and the editor
  extension, which pass `--force-exclude`, and when ruff runs from
  `apps/server`. A bare `ruff check` started at the repo root walks into the
  directory anyway, because it reads `force-exclude` from the root, which
  has no ruff config.
- `apps/web/src/components/ui/`: shadcn/ui components as
  `bunx --bun shadcn add` writes them. `sonner.tsx` is the exception, since it
  was rewritten by hand. The same goes for `components.json` (`shadcn init`)
  and `.vscode/launch.json` (Astro's scaffold). All of these are excluded in
  `apps/web/biome.jsonc`.
- `apps/server/uv.lock`: skipped by `check-toml`; CI's `uv lock --check`
  validates it.

The security checks (gitleaks, private keys, large files, merge markers) still
scan everything, generated or not.

The pre-commit file also lints the workflows under `.github/workflows/`
(actionlint, through its Docker image so shellcheck runs the same
everywhere, and zizmor for security issues), and checks that the mermaid block in
`docs/ROADMAP.md` is a byte-identical copy of `docs/roadmap-timeline.mmd`.

The gitleaks hook scans staged changes only, so it guards `git commit` and
does nothing under `--all-files`: CI and `make lint` skip it. The commits
themselves are scanned by CI's Secrets job and `make secrets`. A finding that
is not a secret goes in `.gitleaksignore` by fingerprint, with the reason
above it. GitHub's push protection blocks recognized provider keys
separately. If a generated file is ever edited by
hand, it is no longer generated: take it off its exclusion list.
