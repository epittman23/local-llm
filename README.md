# local-llm

A personal AI assistant for private, unlimited use: chat, document Q&A and
coding help backed by open-weight models, through OpenRouter today and a
local llama.cpp server under evaluation. It is one app in two parts:

- **`apps/server/`**: the FastAPI backend (accounts, chats, knowledge bases
  on Postgres + pgvector, the OpenAI-compatible model connections, and the
  admin-only Benchmarks section that serves, tests and tunes local models).
  It began as a fork of Open WebUI v0.11.3 and is now this project's own
  code; see [NOTICE](NOTICE) for what is derived and its
  license.
- **`apps/web/`**: the Astro + React + shadcn/ui frontend, which the backend
  serves from its last build.

It runs as host processes started by `make backend` (plus `make frontend`
for a dev server while editing the UI), not in Docker: the backend starts and
stops `llama-server` on this machine's GPU. Only Postgres runs in a container
(`infra/docker-compose.yml`).

Why the project exists, its conventions and its maintenance rules are in
[AGENTS.md](AGENTS.md); where everything lives is in [MAP.md](MAP.md).

## Running it

Runs on native Linux (Fedora 44 since 2026-10-09; it ran under WSL2 before
that). Requires Docker Engine with the Compose plugin, with your user in the
`docker` group so `make backend` can run `docker compose` without sudo,
plus `make`, Bun, **Node ≥ 22.12** (Astro's `engines`), and
**[uv](https://docs.astral.sh/uv/)** for the backend (it also provides the
Python 3.12 the backend needs; see [docs/guides/dependencies.md](docs/guides/dependencies.md)). The first
`make backend` builds `apps/server/.venv` from `apps/server/uv.lock`
(about 2.5 GB); later runs only re-check it against the lock.

A plain `git clone` is enough — the fork lives inside `apps/server/` as
ordinary tracked files, not a submodule. Put your secrets in `infra/.env`
(gitignored; `cp infra/.env.example infra/.env` gives you the keys):

```bash
# infra/.env
OPENROUTER_API_KEY=<your OpenRouter API key, from https://openrouter.ai/keys>
POSTGRES_PASSWORD=<openssl rand -base64 24>
WEBUI_SECRET_KEY=<openssl rand -base64 24>
```

> **Moving from WSL2 to native Linux (2026-10-09).** Nothing gitignored
> comes across with a fresh clone: recreate `infra/.env`, let `make backend`
> build the venv, and rerun `bun install && bun run build` in `apps/web`.
> Docker volumes do not move either, so the `open-web-ui_postgres-data`
> volume (chats, accounts, benchmark history, profile edits) starts empty
> on the new machine unless you `pg_dump` it from the old one and restore
> it. Model weights and `~/llama.cpp` have to be copied or fetched again too
> (see [docs/guides/llama-cpp.md](docs/guides/llama-cpp.md#building-llamacpp) and [docs/guides/model-downloads.md](docs/guides/model-downloads.md)).

> **Upgrading an existing checkout (2026-10-10).** `apps/server/backend/`
> was flattened into `apps/server/`. A `git pull` moves the tracked files but
> not two gitignored directories:
>
> - **The data directory.** `make backend` now pins `DATA_DIR` to
>   `apps/server/data`. Back up and move the old one before the next
>   `make backend`, or the backend starts on an empty uploads/cache
>   directory:
>   ```bash
>   tar -C apps/server/backend -czf ~/local-llm-data-backup-$(date +%F).tar.gz data
>   if [ -e apps/server/data ]; then echo "apps/server/data already exists; merge by hand"; \
>   else mv apps/server/backend/data apps/server/data; fi
>   ```
> - **The venv.** It is now uv's default `apps/server/.venv`, which the next
>   `make backend` builds (quickly, from uv's cache). Afterwards remove the
>   old one and the leftover directory: `rm -rf apps/server/backend`.

then, in one terminal:

```bash
make backend
```

which brings up Postgres (`infra/docker-compose.yml`) and the fork's
backend (`uvicorn`, port `4000`) together, and tears Postgres back down when
the backend stops (Ctrl-C included). The backend listens on `127.0.0.1` only;
to reach it from another machine, start it with
`make backend LLLM_BACKEND_HOST=0.0.0.0`. The backend also serves the frontend
(`apps/web/`, Astro + React + shadcn/ui) from its last build, so build it
once, and again after pulling UI changes:

```bash
cd apps/web && bun install && bun run build
```

Chat is then at `http://localhost:4000/`. While editing the UI, run
`make frontend` in a second terminal instead: a dev server on `:5174` with
hot reload, proxying API/WebSocket calls to the backend (see
[docs/guides/frontend.md](docs/guides/frontend.md)).

The first account you create becomes the admin. Admin accounts also see a **Benchmarks** entry in the
sidebar, at `/benchmarks` — serving, testing, comparison, reporting and
tuning for the local-inference setup below, built into this same frontend
and backend rather than served from a separate dashboard or port. See
[docs/guides/llama-cpp.md](docs/guides/llama-cpp.md) and
[docs/guides/benchmarks.md](docs/guides/benchmarks.md).

## Pages and URLs

Every page the frontend serves, derived from
`apps/web/src/routes/AppRouter.tsx` (and `routePaths.ts`); when routes
change, update this section in the same change.

Base is `http://localhost:4000` (or the `make frontend` dev server, `http://localhost:5174`). Anything
signed-in-only bounces to `/auth?redirect=<path>` when you have no session.
Anything marked *admin* also needs `role === 'admin'`.

### Public (no session needed)

| Path | What you get |
|---|---|
| `/auth` | Sign in / sign up / LDAP / OAuth / onboarding. Query: `?redirect=<path>` (where to go afterwards), `?form=<any>` (shows the login fields and skips the SSO auto-redirect), `?state=logout`, `?error=<msg>` |
| `/error` | The "Backend Required" page. Redirects home once the backend config has loaded, so you only *stay* here when the backend is down |
| `/watch?v=<id>` | Redirects to `/?youtube=<id>`, which attaches that video to a new chat |
| `/s/<share-id>` | Read-only shared chat. The id comes from a chat's Share dialog (sidebar chat menu > Share) |

### Signed-in

| Path | Notes |
|---|---|
| `/workspace` | Redirects: admin → `/workspace/models`; others → the first section they hold permission for (models → knowledge → prompts → tools → skills), else `/` |
| `/workspace/models` | List, bulk actions, pinning |
| `/workspace/models/create` | Model editor, new |
| `/workspace/models/edit?id=<model-id>` | Model editor; **query param, not a path segment** |
| `/workspace/knowledge` | List |
| `/workspace/knowledge/create` | The list with the create dialog already open |
| `/workspace/knowledge/<id>` | Detail page: file tree, uploads, folder sync |
| `/workspace/prompts` | List |
| `/workspace/prompts/create` | The list with the create dialog already open |
| `/workspace/prompts/<id>` | Edit page and version history (the id is the prompt's id) |
| `/workspace/skills` | List |
| `/workspace/skills/create` | Skill editor, new |
| `/workspace/skills/edit?id=<skill-id>` | Skill editor; query param |
| `/workspace/tools` | List. Hidden from the tab bar when the backend has plugins off, but an admin can still open the URL |
| `/workspace/tools/create` | Tool editor, new (CodeMirror) |
| `/workspace/tools/edit?id=<tool-id>` | Tool editor; query param |
| `/workspace/functions/create` | Redirects to `/admin/functions/create` |
| `/admin` | *Admin* (everything under `/admin` is). Redirects to `/admin/users/overview` |
| `/admin/users/overview` | Users: paginated, sortable, searchable list; add (form or CSV), edit, chats, delete. `/admin/users` redirects here |
| `/admin/users/groups` | Groups and their permission switches, member CSV import, default permissions |
| `/admin/evaluations/leaderboard` | Leaderboard and activity chart. `/admin/evaluations` redirects here |
| `/admin/evaluations/feedback` | Feedback table, details, JSON/CSV export |
| `/admin/functions` | Functions list. Bounces to `/admin` when the backend has plugins off |
| `/admin/functions/create` | Function editor, new |
| `/admin/functions/edit?id=<function-id>` | Function editor; query param |
| `/admin/settings[/<tab>]` | **Not a page:** redirects to `/?settings=admin:<tab>`, which opens the Settings modal on that tab (see below) |
| `/admin/analytics[/<tab>]` | Redirects to `/?settings=admin:analytics`, or to `/admin` when analytics is off |
| `/benchmarks` | Redirects to `/benchmarks/serve`. *Admin*, and the backend's `features.enable_benchmarks` must not be `false`; otherwise you're sent to `/` |
| `/benchmarks/serve` | Serve + the Profiles panel |
| `/benchmarks/live` | Live telemetry |
| `/benchmarks/tests` | Test runs (executes model-generated Python; read [the warning](docs/guides/benchmarks.md#grading) first) |
| `/benchmarks/compare` | Compare runs |
| `/benchmarks/answers` | Answers |
| `/benchmarks/report` | Reports |
| `/benchmarks/tune` | Tuning |
| `/notes` | Notes list. Needs the backend's `features.enable_notes` (and not a denied `notes` permission); otherwise you're sent to `/` |
| `/notes/new` | Creates a note (optionally from `?title=&content=`) and opens it |
| `/notes/<id>` | Note editor (TipTap, autosave) |
| `/calendar` | Month/week/day views. Needs `features.enable_calendar` and, for a non-admin, the `calendar` permission |
| `/automations` | List. Needs `features.enable_automations` and, for a non-admin, the `automations` permission |
| `/automations/<id>` | Detail and runs |
| `/playground` | *Admin.* Chat playground; `/playground/completions` and `/playground/images` alongside |
| `/channels/<id>` | A channel: live messages, threads, reactions, pins, members. Needs `features.enable_channels` (and not a denied `channels` permission). The sidebar lists channels and creates them |
| `/home` | A small hub linking to Notes and Calendar (the Svelte `/home` was an unfinished stub nothing linked to) |
| `/` | Chat, new. Query: `?models=<a,b>` (or `?model=`), `?q=<text>` (sent at once unless `&submit=false`), `?temporary-chat=true`, `?web-search=true`, `?image-generation=true`, `?code-interpreter=true`, `?tools=<ids>` (or `?tool-ids=`), `?youtube=<id>`, `?load-url=<url>` |
| `/c/<id>` | A saved chat. A new chat moves here when the server gives it an id |
| `/folders/<folderId>` | A new chat inside that folder (a missing folder sends you to `/`) |

A workspace section you lack permission for redirects you to `/`.

**Settings is a modal, not a page.** Any page accepts `?settings=<tab>`; for an
admin, `?settings=admin:<tab>` opens the modal on that admin tab and the param
is removed from the URL. Personal tab ids (plain `?settings=<tab>`, anyone):
`general`, `interface`, `notifications`, `shortcuts`, `connections`, `tools`
(Integrations), `personalization`, `audio`, `data_controls`,
`archived_chats`, `account`, `about`; some are shown only when the backend and
your permissions allow them. Admin tab ids (`admin:<tab>`): `general`,
`authentication`, `connections`, `models`, `evaluations`, `integrations`,
`documents`, `web`, `code-execution`, `interface`, `audio`, `images`,
`pipelines`, `db`, `subagents`, `analytics`. An unknown tab falls back to the
first one listed; a non-admin asking for an admin tab gets no modal.

### Anything else

Any path not listed above falls into the router's catch-all, `NotFound`,
which never navigates on its own and renders a 404 page.

### Backend URLs

`http://localhost:4000/` — the built app (above), plus the API. Useful backend URLs:

| URL | What |
|---|---|
| `/docs` | Swagger UI for every endpoint (only when `ENV` is `dev`, the default) |
| `/health` | Liveness check |
| `/api/config` | Public config the frontends read before anyone signs in |
| `/api/v1/**` | The REST API the pages call (auths, models, knowledge, prompts, skills, tools, benchmarks, ...) |
| `/` and every page path | The built Astro app, when `apps/web/dist/` exists (see [Running it](#running-it)) |

Postgres listens on `127.0.0.1:5432` (user/db `openwebui`, password from
`infra/.env`), loopback only.

## Model setup

Under **Workspace → Models**, this project defines one Open WebUI model entry
per task, each wrapping a specific OpenRouter model id:

- **Coding** → `qwen/qwen-2.5-coder-32b-instruct`
- **Reasoning** → `qwen/qwen3.6-27b`

Both models are configured (per-model, in the System Prompt field) with the
following instructions:

```
Please use a formal, professional tone. When applicable, try to explain solutions and their steps.
Be informative and delve into topics to enhance learning and further understanding.
Please prioritize accuracy and correctness for all responses.
If there are any assumptions you make for any response please clearly state them and do not hesitate to ask clarifying questions before providing a full response.
Never use em-dashes, instead use standard punctuation such as colons and semicolons.
```

Model choices and the reasoning for changing them are logged in
[docs/decisions.md](docs/decisions.md).

## Migrating to local hardware later

When ready to self-host (llama.cpp as above, or Ollama/vLLM), update the
connection under **Admin Panel → Settings → Connections**: change the base URL
to your local server's OpenAI-compatible endpoint (`http://localhost:8090/v1`
for a server started from the Serve page, or `http://localhost:11434/v1`
for Ollama), and update the API key if your local server requires one. No
other changes should be necessary, since Open WebUI talks to any
OpenAI-compatible endpoint.

## Documentation

| Topic | Where |
|---|---|
| Conventions, maintenance policy, commit policy | [AGENTS.md](AGENTS.md) |
| Repository layout | [MAP.md](MAP.md) |
| Building llama.cpp, serving profiles, measurements | [docs/guides/llama-cpp.md](docs/guides/llama-cpp.md) |
| Downloading model weights | [docs/guides/model-downloads.md](docs/guides/model-downloads.md) |
| GPU telemetry and throughput records | [docs/guides/telemetry.md](docs/guides/telemetry.md) |
| The Benchmarks section: tests, grading, compare, report | [docs/guides/benchmarks.md](docs/guides/benchmarks.md) |
| The app's own test suites | [docs/guides/testing.md](docs/guides/testing.md) |
| Backend dependencies and the offline model cache | [docs/guides/dependencies.md](docs/guides/dependencies.md) |
| Frontend dev server, build, rough edges | [docs/guides/frontend.md](docs/guides/frontend.md) |
| Why things are the way they are | [docs/decisions.md](docs/decisions.md) |
| History and planned direction | [docs/ROADMAP.md](docs/ROADMAP.md) |

## License

The backend in `apps/server/` is a fork of Open WebUI and stays under its
license; parts of `apps/web/` are derived from Open WebUI's frontend. The
license texts are [LICENSE](LICENSE) and [LICENSE_HISTORY](LICENSE_HISTORY)
at the repository root. [NOTICE](NOTICE) says which parts are derived,
reproduces the multi-license notice and the required copyright notice, and
records the basis for the changed branding (clause 4(i): no more than fifty
end users). The app's Settings > About tab shows the same license and
copyright lines.
