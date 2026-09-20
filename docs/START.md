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

`make frontend` → **http://localhost:5173/** — the only place today where chat,
admin, notes, playground, channels, automations and folders actually work. The
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
| `/workspace/functions/create` | Redirects to `/admin/functions/create` (not ported until Phase 8) |
| `/benchmarks` | Redirects to `/benchmarks/serve`. *Admin*, and the backend's `features.enable_benchmarks` must not be `false`; otherwise you're sent to `/` |
| `/benchmarks/serve` | Serve + the Profiles panel |
| `/benchmarks/live` | Live telemetry |
| `/benchmarks/tests` | Test runs (executes model-generated Python; read the warning in the README first) |
| `/benchmarks/compare` | Compare runs |
| `/benchmarks/answers` | Answers |
| `/benchmarks/report` | Reports |
| `/benchmarks/tune` | Tuning |

A workspace section you lack permission for redirects you to `/`.

### Signed-in, placeholders

`/` (Chat — Phase 10), `/notes` (Phase 9) and `/calendar` (Phase 9) render a
"coming in Phase N" stub. The sidebar links to them.

### Everything else: not on `:5174`

Any path not listed above falls into the router's catch-all, `LegacyFallback`,
which does a full-page `window.location.assign` to the **same path**, on the
assumption that it's a Svelte route. That assumption holds only where Svelte
is mounted at the same origin, and today that's nowhere:

- **On `:5174` it loops.** The dev server answers `/admin` with the Astro
  shell (`200`, by design — `src/middleware.ts` rewrites every 404 to `/`), the
  catch-all fires, reloads `/admin`, and repeats. Measured with no backend: 14
  navigations in 4 seconds, blank page. Stop it by editing the URL. The fix is
  a decision for whoever next touches `LegacyFallback` (probably bounce to
  `:5173` in dev, or show a "not ported yet" page).
- **On `:4000/next` it lands on the API server**, which has no Svelte build to
  serve.

So to reach these surfaces, use the Svelte dev server at **`:5173`**:

| Still Svelte-only | Paths |
|---|---|
| Chat | `/c/<id>`, `/home`, `/folders/<folderId>`, `/channels/<id>` |
| Admin (Phase 8) | `/admin`, `/admin/settings[/<tab>]`, `/admin/users[/<tab>]`, `/admin/analytics[/<tab>]`, `/admin/evaluations[/<tab>]`, `/admin/functions`, `/admin/functions/create`, `/admin/functions/edit` |
| Notes / automations (Phase 9) | `/notes`, `/notes/<id>`, `/notes/new`, `/automations`, `/automations/<id>`, `/calendar` |
| Playground (Phase 9) | `/playground`, `/playground/completions`, `/playground/images` |

(`/notes`, `/calendar` and the workspace/benchmarks/public paths exist on
both apps; on `:5173` you get the Svelte version.)

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
