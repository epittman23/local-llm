# apps/web

The Astro + React + shadcn/ui frontend that will eventually replace
`apps/openwebui`'s SvelteKit app. See the root [`README.md`](../../README.md)
and [`docs/migration-plan.md`](../../docs/migration-plan.md) (Phase 3
onward) for why this exists and what's still ahead of it.

## Running it

`make astro` from the repo root (needs `make backend` running too, for the
API it proxies to). Standalone: `bun install && bun run dev` — dev server on
`:5174`, unprefixed, proxying `/api`, `/ollama`, `/openai`, `/oauth`, `/ws`
to `:4000` (`WEBUI_BACKEND_URL` to override).

**`astro dev` daemonizes.** This Astro version's `dev` command always spawns
the real server as a background process, even without `--background` — the
CLI wrapper exits almost immediately either way. `astro dev status` shows
what's running; `astro dev stop` stops it; `astro dev logs --follow`
attaches to a running one. `make astro` and `playwright test` (see below)
both already account for this; a bare `bun run dev` in a terminal will leave
the server running after Ctrl-C unless you `astro dev stop` it yourself.

## Building it

`bun run build` — static output to `dist/`, with every asset path prefixed
`/next` (`astro.config.mjs`'s `base`), because that's where `main.py` mounts
it as a preview alongside the still-live SvelteKit app (`/next/...`, not
`/`). Dev mode stays unprefixed since nothing mounts *it* under a path.
Phase 11's cutover removes the prefix along with `/next` itself.

## Testing

- `bun run test:unit` (Vitest + React Testing Library, `src/**/*.test.tsx`).
- `bun run test:e2e` (Playwright, `e2e/`). Starts and stops its own dev
  server automatically (`playwright.config.ts`'s `webServer`, with the same
  daemon workaround as `make astro`, plus a `globalTeardown` that force-stops
  it afterward — a clean Playwright run was observed leaving the daemon
  alive despite the signal-based path, so this doesn't rely on that alone).

## Structure

```
src/
├── layouts/Base.astro     <html>/<head>, the anti-FOUC dark-mode script
│                          (mirrors apps/openwebui/src/app.html's), and the
│                          --app-text-scale variable's declaration.
├── pages/[...path].astro  mounts Base + App; the single static entry.
├── middleware.ts          rewrites a dev-server 404 to the root so deep
│                          links work (see its own comment).
├── components/App.tsx     the one persistent client:only="react" root:
│                          providers + routes/AppRouter.tsx.
├── components/layout/     AppShell (sidebar, mobile Sheet, auth gate).
├── components/ui/         shadcn/ui components (`bunx shadcn add <name>`).
├── routes/                react-router: AppRouter.tsx, routePaths.ts,
│   ├── benchmarks/        the seven Benchmarks pages + their gate,
│   └── public/            /auth, /error, /watch, /s/:id (no session needed).
├── lib/                   apis/ (ported from the SvelteKit app), auth/,
│                          stores/ (Zustand), socket/, i18n/, query/, utils/.
└── styles/global.css      Tailwind v4 entry + the shadcn Nova preset's
                           design tokens (see the 2026-09-18 decisions-log
                           entry in docs/CLAUDE.md for why Nova, not the
                           migration plan's original "new-york").
```

`components.json` is shadcn/ui's own config (`style: "radix-nova"`, Lucide
icons, CSS variables). Add components with `bunx --bun shadcn add <name>`,
same as the migration plan's `@astrojs/react` + canonical shadcn/ui
decision.
