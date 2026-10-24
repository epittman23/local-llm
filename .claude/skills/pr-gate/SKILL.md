---
name: pr-gate
description: Prepare a pull request for this repo's CI tripwire (the PR gate) - predict its findings from the diff before pushing, run `make pr-gate` once the PR exists, and draft the `## Gate changes` justification. Use before opening or updating any PR, and whenever the PR gate check fails.
---

# pr-gate

The rules are in `AGENTS.md`, "The CI tripwire" and "Commit policy"; the
patterns are in `.github/scripts/pr_gate.py`. Read both. **Never bypass the
gate**: no label, no admin merge, no edits to its workflow, script or
patterns, no rewording a change to slip past them. When it trips, the owner
decides.

## Before pushing

1. `git fetch origin main`, then predict the findings from the diff against
   `origin/main` (the base diff-cover uses too, `DIFF_BASE`):
   - `git diff --name-only origin/main...` against `PROTECTED_PATHS`,
     `TEST_FILES`, the golden-file patterns and the append-only paths in
     `pr_gate.py`.
   - `git diff origin/main... | grep '^+'` for the suppression patterns listed
     there (`noqa`, `type: ignore`, `biome-ignore`, `@ts-expect-error`,
     skip/only/xfail markers, coverage-ignore comments).
   - Removed test files or fewer `def test_` / `it(` / `test(` definitions.
   - Edited lines inside an existing `docs/decisions.md` entry (new entries
     at the top are fine). The gate fails the file on **any** removed line,
     so never reflow or fix an old entry.
2. Check the title and every commit message: conventional style
   (`type(scope): subject`) and **no attribution lines**. The gate rejects
   `Co-Authored-By` naming Claude or Anthropic, "Generated with Claude",
   `Claude-Session:` and `noreply@anthropic.com`, whatever a harness
   default suggests.
3. If a finding is expected, write the PR body's `## Gate changes` section
   now: one bullet per finding saying why the change is needed and why it
   does not weaken what CI catches. The body becomes the squash commit
   message, so the reasoning lands on `main`.

## After the PR exists

`make pr-gate PR=<number>` runs the gate read-only. It reads the **pushed**
PR through the GitHub API (`gh auth token`), not the working tree, so it
only reflects what has been pushed.

When it reports findings:

1. List every finding.
2. Give each one its reasoning (as above) in the PR body under
   `## Gate changes`.
3. Stop and ask the owner for an explicit yes. Only the owner adds the
   `gate-change-approved` label unless they say otherwise for that PR.
   A push removes the label, so any new commit needs a new approval.
