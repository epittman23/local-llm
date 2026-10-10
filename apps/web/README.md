# apps/web

The Astro + React + shadcn/ui frontend for the backend in `apps/server`. It
replaced the Open WebUI fork's SvelteKit app surface by surface; see the root
[`README.md`](../../README.md) and
[`docs/migration-plan.md`](../../docs/migration-plan.md) (Phases 3-11) for
why. Comments reading `d863707:apps/openwebui/...` name the Svelte file a
piece was ported from; `git show d863707:<path>` opens it.

## Running it

`make frontend` from the repo root (needs `make backend` running too, for the
API it proxies to). Standalone: `bun install && bun run dev` — dev server on
`:5174`, unprefixed, proxying `/api`, `/ollama`, `/openai`, `/oauth`, `/ws`
to `:4000` (`WEBUI_BACKEND_URL` to override).

**`astro dev` daemonizes.** This Astro version's `dev` command always spawns
the real server as a background process, even without `--background` — the
CLI wrapper exits almost immediately either way. `astro dev status` shows
what's running; `astro dev stop` stops it; `astro dev logs --follow`
attaches to a running one. `make frontend` and `playwright test` (see below)
both already account for this; a bare `bun run dev` in a terminal will leave
the server running after Ctrl-C unless you `astro dev stop` it yourself.

## Building it

`bun run build` — static output to `dist/`. The backend serves it at `/`
(`FRONTEND_BUILD_DIR` in `apps/server/backend/open_webui/env.py` defaults to
this `dist/`), so after a build `make backend` alone serves the whole app on
`:4000`. At boot the backend copies `dist/static/` into its own static
directory, which is where `/static/favicon.png` and friends come from.

## Testing

- `bun run test:unit` (Vitest + React Testing Library, `src/**/*.test.tsx`).
- `bun run test:e2e` (Playwright, `e2e/`). Starts and stops its own dev
  server automatically (`playwright.config.ts`'s `webServer`, with the same
  daemon workaround as `make frontend`, plus a `globalTeardown` that force-stops
  it afterward — a clean Playwright run was observed leaving the daemon
  alive despite the signal-based path, so this doesn't rely on that alone).
- `bunx astro check` for types (expect 0 errors).
- `bun run format` (Biome: formats, and applies safe lint fixes) and
  `bun run lint` (Biome, check only). Config is `biome.jsonc`. The repo's
  pre-commit hook runs Biome's formatter on every commit; until the existing
  lint findings are fixed it doesn't lint yet (see the root
  `.pre-commit-config.yaml`). If a commit is rejected because the hook
  reformatted a file, `git add` it and commit again.
- Playwright runs flaky on this 20-core machine at its default worker count
  (half the cores, about 10): the cold `astro dev` server can't answer that
  many browsers in time, and redirect assertions hit their 5 s timeout.
  This fails on `main` too, so it isn't caused by any one change.
  `bunx playwright test --workers=2` (CI's count) runs clean.

The e2e specs mock every `/api/v1/**` response and stub `/ws`, so they need
**no backend**, and they will fight a `make frontend` you already have
running: they reuse it if present, which is fine, and `global-teardown.ts`
stops it afterward, which is not. Stop `make frontend` first. Backend tests:
from `apps/server/backend/`, `WEBUI_SECRET_KEY=<any long string>
.venv/bin/python -m pytest tests` (the package imports from the working
directory, and refuses to load without a secret key). One test,
`test_imports.py::test_the_app_imports`, imports the whole app, which
connects the default vector store (pgvector) and runs migrations. It needs
`TEST_DATABASE_URL` pointing at a **throwaway** Postgres with pgvector (never
the `make backend` database), e.g. `docker run --rm -d -p 127.0.0.1:55432:5432
-e POSTGRES_USER=openwebui -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=openwebui
pgvector/pgvector:pg16` and
`TEST_DATABASE_URL=postgresql://openwebui:throwaway@127.0.0.1:55432/openwebui`.
Without it the test skips locally; CI provides one and fails rather than
skips. pytest comes from
`pyproject.toml`'s `dev` dependency group, which `make backend`'s
`uv sync` installs by default.

## Known rough edges

- **Real-backend coverage is a smoke pass, not a suite.** Every page was
  built against mocked responses; on 2026-09-27 each surface was driven once
  against a real backend (Phase 11 of `docs/migration-plan.md`), which found
  and fixed eight bugs. Anything that pass did not touch has only met mocks.
- **`astro dev` runs on Node, not Bun.** Vite's websocket proxy calls
  `socket.destroySoon()`, which Bun lacks, so under `bunx --bun` the dev
  server died the first time a `/ws` connection closed. Keep `--bun` off it.
- **`astro dev` daemonizes.** The Makefile wraps it so Ctrl-C works; if a
  stray one is left running, `cd apps/web && bunx astro dev stop`.
- **Sending in the first second after load** shows "Model not selected"
  until the model list arrives (the Svelte app behaved the same).
- **English only for now.** No page calls `useTranslation` yet.

## Structure

```
src/
├── layouts/Base.astro     <html>/<head>, the anti-FOUC dark-mode script
│                          (mirrors d863707:apps/openwebui/src/app.html's), and the
│                          --app-text-scale variable's declaration.
├── pages/[...path].astro  mounts Base + App; the single static entry.
├── middleware.ts          rewrites a dev-server 404 to the root so deep
│                          links work (see its own comment).
├── components/App.tsx     the one persistent client:only="react" root:
│                          providers + routes/AppRouter.tsx.
├── components/layout/     AppShell (sidebar, mobile Sheet, auth gate).
├── components/common/     app-level components shared across surfaces.
├── components/settings/   the Settings modal, its form controls, and the
│                          connection/tool/terminal modals and
│                          InterfaceSettings; personal/ holds the
│                          twelve personal tabs.
├── components/ui/         shadcn/ui components (`bunx shadcn add <name>`).
├── routes/                react-router: AppRouter.tsx, routePaths.ts,
│   ├── benchmarks/        the seven Benchmarks pages + their gate,
│   ├── workspace/         Phase 7: layout, tabs, per-section permission gate;
│   │                      prompts/, skills/, tools/, knowledge/, models/.
│   ├── admin/             Phase 8: layout + gate; users/, evaluations/,
│   │                      functions/; settings/ and analytics/ are the
│   │                      Settings modal's admin tab bodies.
│   ├── notes/, calendar/, automations/, playground/, channels/,
│   │   home/              Phase 9, each feature-gated (lib/access/features.ts);
│   │                      channels/ is the first Socket.IO consumer.
│   ├── chat/              Phase 10: /, /c/:id, /folders/:id (one layout
│   │                      route), the input, message actions, controls,
│   │                      artifacts, and sidebar/ (the chat list).
│   └── public/            /auth, /error, /watch, /s/:id (no session needed).
├── lib/                   apis/ (ported from the SvelteKit app), auth/,
│                          access/ (grant rules), chat/ (history, request,
│                          sources: pure, unit-tested), markdown/, emoji/,
│                          settings/, stores/ (Zustand),
│                          socket/, i18n/, query/, utils/.
└── styles/global.css      Tailwind v4 entry + the shadcn Nova preset's
                           design tokens (see the 2026-09-18 decisions-log
                           entry in docs/CLAUDE.md for why Nova, not the
                           migration plan's original "new-york").
```

`components.json` is shadcn/ui's own config (`style: "radix-nova"`, Lucide
icons, CSS variables). Add components with `bunx --bun shadcn add <name>`,
same as the migration plan's `@astrojs/react` + canonical shadcn/ui
decision.
