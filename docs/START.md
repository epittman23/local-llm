# START — running the app in its current state

How to bring up the Python backend and the new Astro frontend today, and every
URL that works. Written mid-migration (after Phase 7 of
[migration-plan.md](migration-plan.md)); when that plan's status board moves,
the second half of this file goes stale first — the route table is derived from
`apps/web/src/routes/AppRouter.tsx`, so re-derive it from there.

Two frontends exist side by side. The **Astro/React app** (`apps/web/`) is the
one being built; the **SvelteKit app** (`apps/openwebui/`) still owns every
surface that hasn't been ported. Both talk to one backend.

| Process | Command | Port | What it is |
|---|---|---|---|
| Backend | `make backend` | `:4000` | Postgres (Docker) + the Open WebUI fork's FastAPI app, `uvicorn --reload` |
| Astro dev | `make astro` | `:5174` | the new frontend; proxies API/WS calls to `:4000` |
| Svelte dev | `make frontend` | `:5173` | the old frontend; proxies to `:4000` |

## 1. One-time setup

- Docker Desktop with WSL integration for this distro, `make`, **Bun**,
  **Node ≥ 22.12** (Astro's `engines`), and Python **3.11 or 3.12** (the
  backend's `requires-python`; the Makefile finds one itself, or set
  `LLAMA_OPENWEBUI_PYTHON`).
- `infra/.env` (gitignored) with three keys:

  ```bash
  OPENROUTER_API_KEY=<from https://openrouter.ai/keys>
  POSTGRES_PASSWORD=<openssl rand -base64 24>
  WEBUI_SECRET_KEY=<openssl rand -base64 24>
  ```

  `make backend` refuses to start without the file.
- The first `make backend` builds `apps/openwebui/backend/.venv` and installs
  the fork's requirements (several GB, slow). Later runs skip it.
- `make astro` runs `bun install` in `apps/web/` if `node_modules` is missing.

## 2. Running it

### Full stack (what you normally want)

```bash
make backend     # terminal 1 — Ctrl-C also stops Postgres
make astro       # terminal 2 — Ctrl-C stops the dev server
```

Open **http://localhost:5174/**. The first account created on a fresh database
becomes the admin (sign up at `/auth`). Sign-in is a `token` cookie, and
cookies ignore ports, so being signed in on `:5173` also signs you in on
`:5174` and `:4000`.

Never `docker volume rm` or rename the Postgres volume: the compose project
name is pinned so `open-web-ui_postgres-data` keeps being the one used. A
*new, empty* volume in `docker volume ls` means stop and look.

### Astro app only, no backend

`make astro` works alone, but every page will end up on `/error` ("Backend
Required"): the app fetches `/api/config` on load, the proxy has nothing to
reach, and the session never resolves. Useful only for seeing that page. The
Playwright suite gets around this by mocking `/api/v1/**` (see §5).

### The built copy at `/next`

The backend also serves a **production build** of the Astro app at
**http://localhost:4000/next/**:

```bash
cd apps/web && bun run build     # writes apps/web/dist/ (gitignored)
# then (re)start `make backend`
```

Two catches. The mount is decided **when the backend starts**: if `dist/` didn't
exist then, restart the backend after building (`--reload` only watches Python
files, and never re-mounts). And `dist/` is a snapshot: it does not follow your
edits, so `:5174` is the place to develop. In a build the router's base is
`/next`, so every URL below becomes `/next/<path>`.

### The Svelte app

`make frontend` → **http://localhost:5173/** — the only place today where chat
(`/`, `/c/<id>`, and chatting inside a folder) actually works. The
backend on `:4000` does *not* serve a Svelte build in this setup (no
`apps/openwebui/build/`), so `:4000/` is API-only.

## 3. Valid URLs on the Astro app

Base is `http://localhost:5174` (or `http://localhost:4000/next`). Anything
signed-in-only bounces to `/auth?redirect=<path>` when you have no session.
Anything marked *admin* also needs `role === 'admin'`.

### Public (no session needed)

| Path | What you get |
|---|---|
| `/auth` | Sign in / sign up / LDAP / OAuth / onboarding. Query: `?redirect=<path>` (where to go afterwards), `?form=<any>` (shows the login fields and skips the SSO auto-redirect), `?state=logout`, `?error=<msg>` |
| `/error` | The "Backend Required" page. Redirects home once the backend config has loaded, so you only *stay* here when the backend is down |
| `/watch?v=<id>` | Redirects to `/?youtube=<id>` (the chat page will consume it in Phase 10) |
| `/s/<share-id>` | Read-only shared chat. The id comes from a chat's Share dialog in the Svelte app |

### Signed-in, implemented

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
| `/benchmarks/tests` | Test runs (executes model-generated Python; read the warning in the README first) |
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
| `/folders/<folderId>` | Checks the folder (a missing one sends you to `/`) and names it; chatting inside it is Phase 10 |

A workspace section you lack permission for redirects you to `/`.

**Settings is a modal, not a page.** Any page accepts `?settings=<tab>`; for an
admin, `?settings=admin:<tab>` opens the modal on that admin tab and the param
is removed from the URL. Tab ids: `general`, `authentication`, `connections`,
`models`, `evaluations`, `integrations`, `documents`, `web`, `code-execution`,
`interface`, `audio`, `images`, `pipelines`, `db`, `subagents`, `analytics`.
An unknown tab falls back to the first one listed; a non-admin asking for an
admin tab gets no modal. The personal tabs (plain `?settings=<tab>`) arrive
with Phase 10.

### Signed-in, placeholders

`/` (Chat, Phase 10) renders a "coming in Phase 10" stub.

### Everything else: not on `:5174`

Any path not listed above falls into the router's catch-all, `LegacyFallback`,
which never navigates on its own (it used to bounce to the same path, which
looped on the dev server). A path that still belongs to the Svelte app says so
and links to it: `:5173` in development, the same path in a build. Anything
else is a 404 page.

| Still Svelte-only | Paths |
|---|---|
| Chat | `/c/<id>` (and `/`, which here is only a stub) |

## 4. Backend URLs

`http://localhost:4000/` — API only in this setup. Useful ones:

| URL | What |
|---|---|
| `/docs` | Swagger UI for every endpoint (only when `ENV` is `dev`, the default) |
| `/health` | Liveness check |
| `/api/config` | Public config the frontends read before anyone signs in |
| `/api/v1/**` | The REST API the pages call (auths, models, knowledge, prompts, skills, tools, benchmarks, ...) |
| `/next/` | The built Astro app (see §2) |

Postgres listens on `127.0.0.1:5432` (user/db `openwebui`, password from
`infra/.env`), loopback only.

## 5. Tests

From `apps/web/`:

```bash
bunx astro check       # types — expect 0 errors
bun run test:unit      # Vitest
bun run test:e2e       # Playwright; starts its own dev server on :5174
```

The e2e specs mock every `/api/v1/**` response and stub `/ws`, so they need
**no backend** — and they will fight a `make astro` you already have running
(they reuse it if present, which is fine, and `global-teardown.ts` stops the
server afterward, which is not). Stop `make astro` first, or expect it to be
killed. Backend tests: from `apps/openwebui/`,
`backend/.venv/bin/python -m pytest backend/tests`.

## 6. Known rough edges

- **The catch-all loop on `:5174`** described in §3.
- **Nothing here has met a real backend.** Every Phase 5–7 page was built and
  tested against mocked responses; the first real run may surface bugs.
- **Dev server under Bun.** With no backend on `:4000`, the `/ws` proxy error
  can crash `astro dev` about 30 s in (Bun's sockets lack `destroySoon`). The
  same could happen if the backend restarts under `--reload`. If the page dies
  with `ERR_CONNECTION_REFUSED`, run `make astro` again.
- **`astro dev` daemonizes.** The Makefile wraps it so Ctrl-C works; if a
  stray one is left running, `cd apps/web && bunx --bun astro dev stop`.
- **English only for now.** No page calls `useTranslation` yet.
