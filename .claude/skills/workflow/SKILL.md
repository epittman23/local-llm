---
name: workflow
description: How work is done in this repo, from issue to merged PR, and how an unattended multi-PR run is driven. Use when starting any change, opening or watching a PR, briefing a subagent, verifying against a real backend, or planning a long unattended run.
---

# workflow

The rules are in `AGENTS.md`; this skill is the order of work. It points at
the other project skills instead of repeating them. Sections B to G are
owner decisions of 2026-11-26 (`docs/decisions.md`).

## A. Every change

1. Branch fresh from an updated `main`. `main` takes squash-merged PRs only.
2. Plan first. For broad work explore before planning, so the plan fits what
   is there.
3. Build, with tests that have no skip, only or suppression markers. Never
   delete or weaken a test to get green: the PR gate trips on it.
4. Docs in the same change (`docs-sync`); a UI change also follows
   `ui-standard`.
5. `make check` green locally. Two runs at once on one machine interfere
   (ports, stub processes), so serialize the Playwright step with
   `flock` on one shared lock file.
6. The `reviewer` agent pass; fix its blocking and should-fix findings
   before the PR. Nobody else reads the PR.
7. Open the PR ready, not draft, so auto-merge applies. The body holds
   `Closes #N` (the squash commit uses the body, and the issue only closes
   from it). For UI changes add dark-first screenshots: push them to the
   `ux-review-2026-11-14` evidence branch and link them by raw URL at a
   commit, so the link never moves.
8. `make pr-gate PR=<n>` (`pr-gate` skill).
9. Watch the checks with a Monitor until the PR merges. Resolve every
   CodeQL review thread: they are required, and an open one blocks the
   merge. Fix failures at the cause.
10. After the merge, check the issue closed; close it by hand if the body
    lacked `Closes #N`.

## B. PR shape

- One focused PR per issue or plan phase, and one PR open at a time, so a
  failure has one suspect.
- Later items may be built meanwhile on stacked branches.
- After each squash merge, **merge** `origin/main` into the next branch,
  never rebase (a rebase rewrites commits main already holds). Conflicts
  resolve to the branch side, because main holds the squash of those same
  commits. Then restore any fix main gained after the branch point, and
  check `git diff origin/main --stat` shows only that item.

## C. The PR gate

- Any finding not explicitly pre-approved for that PR: stop, write
  `## Gate changes` in the body, push-notify the owner, wait.
- Never add the label, reword, or restructure a change to slip past a
  pattern. A push removes the label; re-add it only when the owner's
  approval covers the new commit.
- Prevention: the patterns are textual and match inside strings, so a new
  fixture must not contain `fit(`, `xit(`, `.only`, `.skip`, `noqa` and
  the like (a Python `def fit(x)` in a fixture tripped "focused tests").

## D. Subagents

- Default model Sonnet. Pick effort by the task: low for lookups, medium
  for scoped builds and reviews, high for security-sensitive or
  architectural work.
- Each brief names the worktree and branch, the files the agent owns, the
  binding decisions, the checkpoints to report verbatim, and the PR-gate
  cautions of C.
- The orchestrator reads the diffs, screenshots and claims before committing
  or pushing; an agent's "done" is not evidence.
- Parallel executors only on disjoint files. Retry on a git `index.lock`;
  never `git add -A` (it stages a worktree's `node_modules` symlink, which
  `.gitignore`'s `node_modules/` pattern does not match).
- Planners cannot write files: they return the plan as their final message
  and the orchestrator saves it.
- A resumed agent keeps its context, so send follow-ups with SendMessage
  instead of spawning a new one.

## E. Real-backend verification

Required when a change crosses the frontend/backend seam or touches the
sandbox, because Playwright mocks the backend.

1. Use `scripts/throwaway-stack` (its README has the commands and rules).
   Never the owner's `:4000`, `:5432`, `:6379`, `apps/server/data` or
   containers.
2. Build `apps/web` first when the frontend changed, run the flow in the
   browser against the stub, and for the sandbox start the mirror and clean
   up as the README says.
3. Record in the PR body what ran: the ports, the flow, what was seen, and
   what the stub cannot show.

## F. The owner's real stack

Only when the owner explicitly asks (for example to update Workspace model
entries). Run `make backend` in its own session; act through the API with a
short-lived token minted by the app's own `create_token` for the admin;
stop with one SIGINT to the make process group, never two (the second skips
the teardown that stops the served model); confirm the containers stopped.

## G. Unattended runs

1. Plan with the owner first: every foreseeable question, and the gate
   pre-approvals listed per PR.
2. Keep a hand-back file (`RESUME.md`) and the plan outside the repo, and
   update the hand-back after every checkpoint, so a fresh session resumes
   from it. Track goals under an ultragoal plan id.
3. A session cron, about every 23 minutes at an off-minute, reads the
   hand-back and continues.
4. Read usage from OMC's usage cache; a stale cache means unknown. Above
   about 85% of the 5-hour window start no new subagents and only finish the
   step in hand. After a limit hits, resume background agents with
   SendMessage once it resets.
5. Push-notify the owner only for a decision only they can make, a blocking
   failure, or run complete.
6. Never self-certify a final quality gate; leave it to the owner.
7. Pitfalls: a `pgrep -f` wait loop matches itself and never ends; `make
   backend`'s shutdown removes the sandbox mirror container; see D for the
   `node_modules` symlink.

## H. Closeout

Every PR merged, issues closed, the tracking issue closed with a summary,
the cron deleted, memory updated, and a final report to the owner.
