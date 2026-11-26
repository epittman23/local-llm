# Throwaway stack

A disposable backend, database, Redis and stub model for checking a change
against a real backend without touching the owner's stack. The `workflow`
skill says when that is required. Everything lives under
`${XDG_STATE_HOME:-~/.local/state}/local-llm-throwaway/` (logs, pid files,
data directories).

| Script | What it does |
|---|---|
| `up.sh` | Starts, creating if missing, `lllm-throwaway-pg` (`pgvector/pgvector:pg16`) and `lllm-throwaway-redis`, with test-only credentials, on `127.0.0.1:55440` and `:56380` (`LLLM_THROWAWAY_PG_PORT`, `LLLM_THROWAWAY_REDIS_PORT`), and waits until both answer. |
| `stub.sh [PORT]` | Starts `stub.py`, an OpenAI-compatible stub model, on PORT (default 4190) and records the port for `backend.sh`. The phrases that pick its replies (plain, slow stream, fenced HTML, `bash` tool calls for sandbox outputs, a 503) are at the top of `stub.py`. |
| `backend.sh PORT [DIST] [DATA] [SERVER_DIR]` | Starts the backend (no `--reload`) on PORT against the throwaway containers and the stub, and waits for `/ready`. DIST defaults to `apps/web/dist` (build it first with `cd apps/web && bun run build`), DATA to a directory in the state directory, SERVER_DIR to this checkout's `apps/server` (give a worktree's for backend changes). |
| `down.sh` | Stops the stub and every backend these scripts started (by pid file), then stops, without deleting, the two containers. |

Typical run: `up.sh`, `stub.sh 4191`, `backend.sh 4108`, check, `down.sh`.

## Rules

- **Never the owner's.** `backend.sh` refuses ports 4000, 5432 and 6379 and
  any DATA under `apps/server/data`; no script touches a `local-llm-*`
  container. Use ports and names of your own for anything else.
- **The sandbox mirror is the owner's container.** For a sandbox check start
  it with `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d sandbox-mirror`
  and stop it afterwards. Remove the sandbox containers you created, and
  their loop devices with `udisksctl loop-delete`.
- **Test-only credentials.** Nothing here holds a real secret or owner data.

## Signing in

A fresh database has no user. The first sign-up becomes the admin:

```sh
curl -s -X POST http://127.0.0.1:4108/api/v1/auths/signup \
  -H 'content-type: application/json' \
  -d '{"name":"admin","email":"admin@example.com","password":"test-only-password"}'
```

Then sign in at `http://127.0.0.1:4108/` with those. Add a connection to the
stub (`http://127.0.0.1:4191/v1`, any key) only if the backend's default does
not already list its models.
