# The desktop app

`apps/desktop` is a small Electron app. It shows Local LLM in a window of its
own and, when the server is this machine, starts and stops the local stack
itself, so the app needs no terminal. It does **not** carry its own copy of
the frontend. Its window loads the backend's own address
(`http://127.0.0.1:4000` by default), which serves the last build of
`apps/web` at `/`. The desktop app and a browser therefore run the same pages
from the same origin, with the same features. A UI or backend change never
needs the desktop app rebuilt.

Linux (Fedora) only, packaged as an `.rpm` (docs/decisions.md, 2026-10-23).

## Installing it

```bash
sudo dnf install rpm-build libxcrypt-compat   # once: what electron-builder's rpm step runs on
cd apps/desktop
bun install
bun run package                     # writes release/local-llm-desktop-<version>.x86_64.rpm
sudo dnf install ./release/local-llm-desktop-*.rpm
```

`libxcrypt-compat` is there for the Ruby that electron-builder bundles to
make the `.rpm` (`fpm`), which needs `libcrypt.so.1`. Without it the build
stops with "libcrypt.so.1: cannot open shared object file". After pulling
changes to `apps/desktop`, build and install it again; changes to the
backend or `apps/web` need nothing.

It then appears in the app launcher as **Local LLM** (its `.desktop` entry). The package records the
checkout it was built from as the default repository folder
(`dist/build-info.json`). Build it from the checkout you use, or set the
folder in Settings.

To run it from the checkout instead, while working on it, use `make desktop`.
Ctrl-C there closes the app, the same way as closing its window. Press it
**once**: Electron takes a first SIGINT as "quit" and dies of a second, which
leaves the stack running (the next launch adopts it, and closing that stops
it).

## What happens when it opens

A progress dialog lists each step as it runs, with its time, the latest line
of output, and **Show details** for the whole log. The dialog has a fixed
size, which tiling compositors such as Hyprland and sway take as a cue to
float it rather than tile it. What it does depends on what is already
running:

| Found | It does | On close |
|---|---|---|
| Nothing answering on `:4000` | builds `apps/web` if any source is newer than `dist/`, then runs `make backend` | stops everything it started |
| A backend already up (from a terminal) | connects to it: nothing is restarted or rebuilt | leaves it running |
| The stack it started before it crashed | adopts it (`owned.json`; the same `make`, by pid and start time) | stops it |
| `make frontend` on `:5174` | loads the hot-reloading dev server instead of the build, and skips the build | the dev server is left alone |
| A server address that isn't loopback | connects only | nothing to stop |

`:5174` and `:4000` are different origins, so each keeps its own login.

The backend it starts runs `make backend LLLM_UVICORN_FLAGS='--timeout-graceful-shutdown 10'`
with `LLLM_STOP_JOBS_ON_SHUTDOWN=true`.
- **No `--reload`:** backend code edits don't take effect while the app owns
  the stack. Use a terminal `make backend` while working on the backend; the
  app then attaches to it.
- **A bounded shutdown:** without the timeout, uvicorn waits forever on an
  open stream, such as the Serve page's log.
- **The backend stops its own jobs on exit:** a Tests job, a tune sweep, and
  then the served `llama-server`. By default all three outlive the backend
  (llama-cpp.md, Serving).

It runs `make` through your login shell (`$SHELL -lc`), so `uv`, `bun`, `node`
and `docker` are found as in a terminal. An app started from the launcher
otherwise has a minimal PATH. The requirements are the same as for
`make backend` (README, "Running it").

## What happens when it closes

If it started the stack, the dialog shows the shutdown:
1. **The app window is destroyed.** Hiding it would keep its streams open.
2. **One SIGINT goes to `make`'s process group,** exactly as Ctrl-C would.
   Never a second one: uvicorn takes a second SIGINT as "force exit" and skips
   the teardown that stops the served model.
3. **uvicorn finishes open requests** (cancelled after 10 s), then stops
   benchmark jobs and the served model.
4. **The Makefile's trap brings the Compose services down** (Postgres,
   Redis, Jupyter and SearXNG).

The app waits until the whole group has exited, with a budget of 90 s. Past
that, it kills the group, runs `docker compose down` itself, and offers to stop
any `llama-server` still running. That server runs in its own session,
outside the group, so it is offered rather than killed unasked.

The steps follow the `==> ` marker lines that the Makefile and the backend's
shutdown hook print. Those lines are an interface: change their text only
together with `src/progress.ts`.

## Settings, and moving to the remote server

**File > Settings…** (Ctrl+,) has two fields:
- **Server URL.** At `127.0.0.1` or `localhost`, the app manages the local
  stack. At any other address, it only connects.
- **Repository folder.** The checkout whose `make backend` it runs.

Moving to the dedicated server means setting the server URL to its
`https://` address and restarting the app. Nothing else changes. Use a real
certificate (Tailscale serve, Caddy); a self-signed one is not handled.
`--server-url=<url>` or `LLLM_SERVER_URL` override the setting for one launch
without saving it.

## Files

Everything lives in `~/.config/Local LLM/`, the same for the packaged app and
`make desktop`:
- `config.json`: the settings and the window's size;
- `owned.json`: the process group of the stack it started, while it runs;
- `logs/backend.log`: the build and `make backend` output of the stack it
  started (the previous run's is `backend.log.1`).

The rest of the directory is the window's browser profile, including local
storage with the login.

## Security model, and adding native features

- **The windows:**
  - the app window runs sandboxed, with context isolation and no Node;
  - navigation off the server's origin goes to the system browser;
  - only the server's origin gets the permissions the app uses
    (notifications, clipboard, microphone, fullscreen). The rules are in
    `src/policy.ts`.
- **Fuses:** the packaged app's Electron fuses turn off `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS` and the inspector.
- **The two bridges:**
  - the dialog's bridge (`src/status-preload.ts`) exists only in its own
    window, and its handlers refuse any sender but the bundled page;
  - the app window's bridge (`src/preload.ts`) exposes only
    `window.lllmDesktop = { platform, version }`, so the frontend can tell
    where it runs.
- **Adding a native feature** (a local coding-agent tool, say) goes through
  `src/preload.ts` and an `ipcMain` handler, and the handler **must**:
  - check `event.senderFrame.origin` against the configured server, as the
    dialog's handlers check their sender;
  - refuse unless that origin is `https:` or loopback.

  Otherwise any page the window shows, or anyone able to tamper with plain
  HTTP on the way, could run things on this machine.

OAuth sign-in is unused (no provider is configured). If it is ever turned on,
its provider's origin must be allowed to navigate in-app (`src/policy.ts`), or
sign-in would break in the desktop app only.

## Testing

`make test-desktop` (CI's "Desktop" job) runs the type check, the unit tests
and an unpacked package. The unit tests cover:
- `src/config.ts`, `src/policy.ts` and `src/stack.ts`'s decisions and stop
  sequence;
- `src/progress.ts`, replayed against logs from real runs in
  `test/fixtures/`.

Launching, closing and attaching are checked by hand: see
[testing.md](testing.md#desktop-appsdesktop).
