# The frontend (`apps/web`)

`apps/web/` is the Astro + React + shadcn/ui frontend for the backend in
`apps/server`. It replaced the original SvelteKit app surface by surface (see
[the migration plan](../history/migration-plan.md), Phases 3-11). Comments
reading `d863707:apps/openwebui/...` name the Svelte file a piece was ported
from; `git show d863707:<path>` opens it. Its layout is mapped in
[MAP.md](../../MAP.md#appsweb-astro--react--shadcnui).

## Dev server

`make frontend` from the repo root (it needs `make backend` running too, for
the API it proxies to). Standalone: `bun install && bun run dev`, a dev
server on `:5174`, unprefixed, proxying `/api`, `/ollama`, `/openai`,
`/oauth` and `/ws` to `:4000` (`LLLM_BACKEND_URL` to override). It also
answers `/__lllm/dev-server` with the `apps/web` it serves
(`dev-server-identity.mjs`): the desktop app loads the dev server in place of
the build only when that is its own checkout's, so keep the plugin.

**`astro dev` daemonizes.** This Astro version's `dev` command always spawns
the real server as a background process, even without `--background`; the
CLI wrapper exits almost immediately either way. `astro dev status` shows
what's running, `astro dev stop` stops it, and `astro dev logs --follow`
attaches to a running one. `make frontend` already accounts for this
(Playwright runs against the built app, not the dev server); a bare `bun run dev` in a terminal leaves the
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
`src/components/ui/` holds the CLI's output and is excluded from Biome, so
leave those files as generated and build on them in your own components.
If one has to be edited by hand, take it off the exclusion in `biome.jsonc`,
as `sonner.tsx` already is: it follows the app's theme class instead of
`next-themes`.
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
- **`package.json` pins `@emnapi/core` and `@emnapi/runtime` to one
  version** (`overrides`). `@astrojs/astro2tsx` (under `@astrojs/check`)
  depends on the core but not the runtime, so it gets whichever runtime is
  hoisted. After #768 that was rolldown's `2.0.0-beta.2` against a 1.11.3
  core, and `astro check` could not load: it exits 0 then, so CI passed
  without checking anything until `.github/scripts/astro_check.py`. Drop
  the pin once `astro2tsx` declares the runtime itself (0.1.3 does not).
- **Sending in the first second after load** waits until the page has
  chosen its models and loaded the tools (whose defaults a model may turn
  on), then goes with what the box holds; opening another chat meanwhile
  drops it (`useHeldSend`, #373). It used to show "Model not selected".
- **Enter while an attachment is still uploading** holds the message
  ("Sends when the upload finishes") and sends it once every upload is
  done and the chat is not reloading (Chat.svelte cleared the box and
  queued such a message instead). Editing the text lets go of it at once,
  and so does a held upload failing or being removed, so a message never
  goes half written or without its file (`ChatInput`). Enter used to do
  nothing then, and say nothing.
- **English only.** No page calls `useTranslation` yet, so only the `en-US`
  locale ships and there is no language picker (the other 63 locale files
  were removed on 2026-10-10).
