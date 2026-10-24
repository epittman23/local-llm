# Agent tooling

What a coding agent (Claude Code, or any agent that reads `.claude/` and
`.mcp.json`) gets from this checkout beyond `AGENTS.md`. Added 2026-10-24.

The skills and the reviewer agent are instructions to the agent. They run
inside it, so whatever the agent reads goes to its model provider as
usual; they add no other network path. codebase-memory-mcp runs on this
machine; its README says it makes no network requests of its own and
collects no telemetry (stated upstream, not measured here).

## Project skills (`.claude/skills/`)

Each skill is a procedure for applying a rule `AGENTS.md` already states.
The skills point at the rule rather than restating it, so `AGENTS.md`
stays the one source of truth. When a rule there changes, check the skill
that applies it.

| Skill | Use it when | It covers |
|---|---|---|
| `docs-sync` | before any commit that changes behaviour, layout, models, flags, targets, routes or a decision | the maintenance-policy checklist, including the roadmap byte-identity check |
| `pr-gate` | before opening or updating a PR, and when `PR gate` fails | predicting the tripwire's findings from the diff, the no-attribution rule, `make pr-gate`, the `## Gate changes` section, asking the owner |
| `new-migration` | any model or table change, or a recorded discontinuity | finding the head revision, an append-only revision, the `benchmark_schema_note` row, the schema-drift test |
| `serving-change` | any edit to `benchmarks/serving/` or a profile | every place a launch-flag change touches, so `config_id` stays right |

Claude Code offers them automatically when a task matches their
description, and `/docs-sync` (and so on) runs one by name.

## Reviewer agent (`.claude/agents/reviewer.md`)

A subagent that reviews the branch's diff
against `main` before a PR is opened. It checks correctness, what the PR
gate will trip on, the maintenance policy, serving-fingerprint safety, tests
and the project's principles. Its tools are Read, Grep, Glob and Bash; it
is instructed not to edit anything, and Bash is there for `git`, but that
is an instruction, not an enforced restriction. It reports findings in four groups: blocking,
should fix, unverified, and checked and clean. Ask for it by name ("use the
reviewer agent on this branch"). Nobody reviews PRs here before they merge,
so it is the only second reader a change gets besides CI. It does not
replace CI.

## codebase-memory-mcp (`.mcp.json`)

A local MCP server ([DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp),
MIT) that parses the repository with Tree-sitter into a graph of functions,
classes, calls and routes, so an agent can ask "what calls X?" without
reading files. `.mcp.json` registers it by command name, so it needs the
binary on `PATH`.

**Install** (pinned, verified by hand; not the project's `curl | bash`
installer, and not its `install` subcommand, which rewrites agent configs
such as `~/.claude.json`):

```sh
d=$(mktemp -d) && cd "$d"
base=https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1
curl -fsSLO "$base/codebase-memory-mcp-linux-amd64.tar.gz"
curl -fsSLO "$base/checksums.txt"
grep ' codebase-memory-mcp-linux-amd64.tar.gz$' checksums.txt | sha256sum -c -
tar xzf codebase-memory-mcp-linux-amd64.tar.gz
install -m 755 codebase-memory-mcp ~/.local/bin/
codebase-memory-mcp --version   # 0.12.1
```

**First use:** restart Claude Code in the checkout and approve the project
server when asked (or under `/mcp`). Then index the repository once, either
by asking the agent to run `index_repository` or from a shell:

```sh
codebase-memory-mcp cli index_repository '{"repo_path":"'"$PWD"'","mode":"fast"}'
codebase-memory-mcp cli trace_path '{"project":"home-epittman-local-llm","function_name":"config_lines","direction":"inbound","depth":2}'
```

The project name comes from the checkout's path; `list_projects` shows it.
On 2026-10-24 a fast index of `main` at `8d1e1b7` took about 7 s
(16,307 nodes, 59,695 edges). The trace above matched `grep`: `config_id`,
`telemetry_argv` and `tune_schedule.config_id_of` call `config_lines`
directly.

**What to know:**

- The index is SQLite under `~/.cache/codebase-memory-mcp/`, outside the
  repo. It skips what `.gitignore` skips (so `infra/.env` is never read),
  and by default `docs/`, `.github/scripts/` and `.claude/` too.
- Its optional shared snapshot (`.codebase-memory/graph.db.zst` in the
  repo) stays off. Turning it on would need a `.gitignore` entry, which is
  a PR-gate change.
- It serves a graph UI on `127.0.0.1:9749` while it runs (loopback only).
  `codebase-memory-mcp config set ui_enabled false` turns that off.
- `auto_index` is off, so a new checkout needs the index step above.
  `auto_watch` is on by default; if answers look stale after large
  changes, index again.
- It answers structure, not intent. `MAP.md` and `AGENTS.md` still say
  why things are where they are.

## Not tracked

`.claude/settings.local.json` (personal permission allowlists) and
`.claude/worktrees/` are local state. Only the second is gitignored, so do
not commit the first.
