---
name: docs-sync
description: Check that a change carries the documentation updates AGENTS.md's maintenance policy requires (decisions log, roadmap timeline, MAP.md, README sections, guides) before committing. Use before every commit that changes behaviour, layout, models, serving flags, Makefile targets, routes or a decision.
---

# docs-sync

The rules are in `AGENTS.md`, "Maintenance policy". Read that section; this
skill is only the procedure for applying it to the change in hand.

1. List what the change touches: `git diff --stat main...` plus
   `git status --short` for anything uncommitted.
2. Walk the table below. For each row whose trigger matches, make the update
   in the same commit, or say why it does not apply.
3. Run `uvx pre-commit run --files <changed files>` (or `make lint`).

| Trigger in the diff | Update |
|---|---|
| A decision changed: a model, provider, tool or approach adopted, dropped or replaced; an evaluation concluded | A new entry at the top of the list in `docs/decisions.md`, below the undated preamble bullet. Absolute date; when that date already has an entry, add a qualifier such as `(later)`. Never edit an existing entry: the PR gate trips on it. |
| A new `docs/decisions.md` entry | The matching milestone in `docs/roadmap-timeline.mmd` **and** in the fenced `mermaid` block of `docs/ROADMAP.md` (check below); revise ROADMAP.md's "Planned future additions" if what is next changed. |
| A top-level directory or major file added, removed, moved or repurposed | Its entry in `MAP.md`. |
| Models, providers, endpoints or serving flags | AGENTS.md "Models in use" / "Local inference", and `docs/guides/llama-cpp.md`. For flags, also use the `serving-change` skill. |
| `serving/profiles.py`, `serving/launcher.py`, the Makefile or `infra/docker-compose.yml` defaults, flags or function names | Their description in README.md or the guides. |
| How the app starts (Makefile targets, ports, `infra/.env` keys, tool versions) | README.md "Running it". |
| A URL the frontend serves (`apps/web/src/routes/AppRouter.tsx`, `routePaths.ts`) added, removed, renamed or given new query parameters | README.md "Pages and URLs". |
| A benchmark number recorded in `docs/guides/` | Hardware, model file, llama.cpp build and flags beside it. |
| The deployed system prompt changed in the app | Copy it byte-for-byte to `apps/server/local_llm/benchmarks/data/prompts/assistant.txt`. That path is append-only for the gate, so the PR needs a `## Gate changes` note. |
| Something described in the docs no longer exists | Delete the description and log the deletion in `docs/decisions.md`. |

Check that the two roadmap diagrams are still byte-identical (it prints
nothing when they match):

```sh
diff docs/roadmap-timeline.mmd <(awk '/^```mermaid$/{f=1;next} /^```$/{f=0} f' docs/ROADMAP.md)
```

State anything not yet running as planned or under evaluation, never as a
fact.
