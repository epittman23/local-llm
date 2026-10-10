# The frontend (`apps/web`)

`apps/web/` is the Astro + React + shadcn/ui frontend for the backend in
`apps/server`. It replaced the fork's SvelteKit app surface by surface (see
[the migration plan](../history/migration-plan.md), Phases 3-11). Comments
reading `d863707:apps/openwebui/...` name the Svelte file a piece was ported
from; `git show d863707:<path>` opens it. Its layout is mapped in
[MAP.md](../../MAP.md#appsweb-astro--react--shadcnui).

## Dev server

`make frontend` from the repo root (it needs `make backend` running too, for
the API it proxies to). Standalone: `bun install && bun run dev`, a dev
server on `:5174`, unprefixed, proxying `/api`, `/ollama`, `/openai`,
`/oauth` and `/ws` to `:4000` (`WEBUI_BACKEND_URL` to override).

**`astro dev` daemonizes.** This Astro version's `dev` command always spawns
the real server as a background process, even without `--background`; the
CLI wrapper exits almost immediately either way. `astro dev status` shows
what's running, `astro dev stop` stops it, and `astro dev logs --follow`
attaches to a running one. `make frontend` and `playwright test` both
already account for this; a bare `bun run dev` in a terminal leaves the
server running after Ctrl-C unless you `astro dev stop` it yourself.

## Building

`bun run build` writes static output to `dist/`. The backend serves it at
`/` (`FRONTEND_BUILD_DIR` in `apps/server/local_llm/env.py`
defaults to this `dist/`), so after a build `make backend` alone serves the
whole app on `:4000`. At boot the backend copies `dist/static/` into its own
static directory, which is where `/static/favicon.png` and friends come from.

## Testing

See [testing.md](testing.md#frontend-appsweb).

## Adding components

`components.json` is shadcn/ui's own config (`style: "radix-nova"`, Lucide
icons, CSS variables). Add components with `bunx --bun shadcn add <name>`.
See the 2026-09-18 entry in [decisions.md](../decisions.md) for why Nova and
not the migration plan's original "new-york".

## Known rough edges

- **Real-backend coverage is a smoke pass, not a suite.** Every page was
  built against mocked responses. On 2026-09-27 each surface was driven once
  against a real backend (Phase 11 of the migration plan), which found and
  fixed eight bugs. Anything that pass did not touch has only met mocks.
- **`astro dev` runs on Node, not Bun.** Vite's websocket proxy calls
  `socket.destroySoon()`, which Bun lacks, so under `bunx --bun` the dev
  server died the first time a `/ws` connection closed. Keep `--bun` off it.
- **`astro dev` daemonizes.** The Makefile wraps it so Ctrl-C works; if a
  stray one is left running, `cd apps/web && bunx astro dev stop`.
- **Sending in the first second after load** shows "Model not selected"
  until the model list arrives (the Svelte app behaved the same).
- **English only.** No page calls `useTranslation` yet, so only the `en-US`
  locale ships and there is no language picker (the other 63 locale files
  were removed on 2026-10-10).
