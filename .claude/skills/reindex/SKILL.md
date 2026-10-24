---
name: reindex
description: Rebuild the codebase-memory-mcp code graph for this checkout and confirm it is current. Use after pulling, switching branches or merging, after large edits, when graph answers (callers, search, outlines) disagree with the files, or when the project is missing from the index.
---

# reindex

codebase-memory-mcp is described in `docs/guides/agent-tooling.md`. Its
index lives in `~/.cache/codebase-memory-mcp/`, outside the repo, so
reindexing never changes the working tree.

## 1. Check what is indexed

Prefer the MCP tools when the `codebase-memory-mcp` server is connected.
Otherwise use the CLI equivalents shown.

- `list_projects` (`codebase-memory-mcp cli list_projects`): find this
  checkout's project. Its name comes from the path. For the main checkout
  at `~/local-llm` it is `home-epittman-local-llm`. A checkout at another
  path, such as a worktree, is indexed under its own name.
- `index_status --project <name>`: `status` should be `ready`. Compare
  `indexed_at` with `git log -1 --format=%cI` and the last pull or
  checkout. If the index is older, or the project is missing, reindex.

If the binary is missing (`command -v codebase-memory-mcp` prints
nothing), stop and point the user to the install steps in the guide. Do
not use the project's `curl | bash` installer or its `install` subcommand.

## 2. Reindex

Index the checkout's root (`git rev-parse --show-toplevel`), not a
subdirectory:

```sh
codebase-memory-mcp cli index_repository --repo-path "$(git rev-parse --show-toplevel)" --mode full
```

Through MCP, that is `index_repository` with `repo_path` and `mode`.

| Mode | When | Measured 2026-10-24 on `bdb6088` |
|---|---|---|
| `full` (default) | normally | about 16 s; about 30,000 nodes, including tests and semantic data |
| `fast` | a quick refresh mid-task | about 7 s; about 16,000 nodes; skips test files and semantic data |

Both ran with networking disabled (`unshare -rn`), so indexing needs no
network.

Never pass `--persistence true`. It writes `.codebase-memory/graph.db.zst`
into the repo, which is untracked and not gitignored.

## 3. Confirm

1. `index_status` shows `ready` and a new `indexed_at`.
2. Spot-check one answer against the files. `trace_path` on
   `config_lines` (inbound, depth 1) should list the same callers as:

   ```sh
   grep -rn "config_lines(" apps/server/local_llm --include=*.py | grep -v "def config_lines\|#"
   ```

   On `bdb6088` that was `fingerprint.config_id`,
   `launcher.telemetry_argv` and `tune_schedule.config_id_of`.
3. Report the mode, the node and edge counts, and anything listed under
   `parse_unusable`.

## Housekeeping

A removed worktree leaves its project in the index. Remove it with
`delete_project --project <name>` once `list_projects` shows a path that
no longer exists. Ask first, since deleting a project cannot be undone.
