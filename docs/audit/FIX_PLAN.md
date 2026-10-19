# Fix plan for the 2026-10-19 bug audit

A self-contained plan for a future session with no memory of the audit.
Findings are in [FINDINGS.md](FINDINGS.md), reproductions in
[repro/](repro/README.md), and non-bug observations in [NOTES.md](NOTES.md).
Security findings are deliberately absent from this repository; the owner
handles them through private security advisories.

## 1. Context

- **Audited commit**: `7a4088b20f3aa27cf35abb07689e68b19408c003` (`main`,
  "fix(server): search knowledge even when a hit has no metadata (#108)").
  Every line reference here and in the issues refers to it; re-locate lines on
  current `main` before editing, since PRs have landed since. #125 (merged
  as `3b754d1`) changed only `apps/server/pyproject.toml` outside application
  code, so the permalinks stay valid for every application file.
- **Environment setup that worked** (Claude Code cloud container):
  1. `infra/.env` with placeholder values for `OPENROUTER_API_KEY`,
     `POSTGRES_PASSWORD`, `LLLM_SECRET_KEY` (never commit it).
  2. Start Docker if `docker info` fails: `dockerd &`.
  3. Backend venv without torch when `download.pytorch.org` is blocked:
     `cd apps/server && UV_PROJECT_ENVIRONMENT=$PWD/.venv uv sync --frozen --no-install-project --group dev --no-install-package torch`.
     Pure-Python repros and almost all of pytest run under it.
  4. Postgres for `tests/test_imports.py` needs `pgvector/pgvector:pg16`; Docker
     Hub may rate-limit (429). Retry later or use CI.
  5. Playwright: if `cdn.playwright.dev` is blocked and `/opt/pw-browsers` holds an
     older Chromium, link the expected revision directory to it (outside the
     repo) and run `cd apps/web && bunx playwright test --workers=2`.
  6. If `git show d863707:...` fails, run `git fetch --unshallow origin main`.
- **Baseline on the owner's laptop** (2026-10-19, Fedora 44, Docker 29.8.2,
  Node 26.10, working tree `3b754d1` plus docs), each Make target run on its own:

  | Check | Result |
  |---|---|
  | `make lint` | pass, no files changed |
  | `make test-backend` | pass: 1618 passed, 21 skipped, 0 failed (`test_the_app_imports` ran against the throwaway pgvector Postgres) |
  | `make test-web` | pass: `astro check` 0 errors, 0 warnings, 13 hints; Vitest 580/580 in 78 files; build OK |
  | `make test-e2e` | pass: 341/341 (9.3 min); the flaky spec in #157 did not fail here |

  Nothing in the working tree changed after the four targets.

- **Baseline in the first (cloud) session**, kept as history:

  | Check | Result |
  |---|---|
  | `make test-web` | pass: `astro check` 0 errors (1 warning), Vitest 580/580 in 78 files, build OK |
  | `make test-e2e` | Make target failed at `playwright install` (network); run directly: 340 passed, 1 failed (A-32, flaky, passed 3/3 alone) |
  | `make test-backend` | Make target failed at `uv sync` (torch index blocked); pytest without torch: 1617 passed, 21 skipped, 1 failed (`test_the_app_imports`: no Postgres, image pull 429) |
  | `make lint` | pass, no files changed |

## 2. Summary table

| Issue | Finding | Title | Severity | Area | Status | Location | Effort |
|---|---|---|---|---|---|---|---|
| [#126](https://github.com/epittman23/local-llm/issues/126) | A-01 | Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin | Critical | benchmarks | Confirmed | `__init__.py:140` | M |
| [#127](https://github.com/epittman23/local-llm/issues/127) | A-02 | config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration | Critical | benchmarks | Confirmed | `fingerprint.py:76` | M |
| [#128](https://github.com/epittman23/local-llm/issues/128) | A-03 | Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show | Critical | benchmarks | Confirmed | `report.py:1895` | S |
| [#129](https://github.com/epittman23/local-llm/issues/129) | A-04 | Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app | High | benchmarks | Confirmed | `compare.py:27` | S |
| [#131](https://github.com/epittman23/local-llm/issues/131) | A-06 | Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison | High | benchmarks | Confirmed | `compare.py:108` | S |
| [#134](https://github.com/epittman23/local-llm/issues/134) | A-09 | Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults | High | benchmarks | Confirmed | `tune.py:1282` | S |
| [#140](https://github.com/epittman23/local-llm/issues/140) | A-15 | Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code | High | benchmarks | Confirmed | `runner.py:352` | M |
| [#141](https://github.com/epittman23/local-llm/issues/141) | A-16 | No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions | High | benchmarks | Confirmed | `datasets.py:90` | M |
| [#130](https://github.com/epittman23/local-llm/issues/130) | A-05 | Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level | Medium | benchmarks | Confirmed | `compare.py:416` | S |
| [#132](https://github.com/epittman23/local-llm/issues/132) | A-07 | Compare ranks rows across tiers together and binds the baseline delta to the first matching group only | Medium | benchmarks | Confirmed | `compare.py:358` | M |
| [#133](https://github.com/epittman23/local-llm/issues/133) | A-08 | Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha | Medium | benchmarks | Suspected | `report.py:1413` | S |
| [#135](https://github.com/epittman23/local-llm/issues/135) | A-10 | Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate | Medium | benchmarks | Confirmed | `tune.py:1175` | S |
| [#136](https://github.com/epittman23/local-llm/issues/136) | A-11 | Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut | Medium | benchmarks | Confirmed | `tune.py:1194` | S |
| [#137](https://github.com/epittman23/local-llm/issues/137) | A-12 | Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses | Medium | benchmarks | Confirmed | `tune.py:515` | S |
| [#138](https://github.com/epittman23/local-llm/issues/138) | A-13 | Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever | Medium | benchmarks | Suspected | `tune.py:942` | M |
| [#142](https://github.com/epittman23/local-llm/issues/142) | A-17 | Grading timeouts kill only the direct child; processes spawned by model code survive | Medium | benchmarks | Suspected | `__init__.py:146` | S |
| [#145](https://github.com/epittman23/local-llm/issues/145) | A-20 | make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap | Medium | infra | Confirmed | `Makefile:118` | S |
| [#150](https://github.com/epittman23/local-llm/issues/150) | A-25 | A reply left unfinished on a non-current branch stays "generating" forever after reload | Medium | web | Confirmed | `history.ts:220` | S |
| [#151](https://github.com/epittman23/local-llm/issues/151) | A-26 | Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped | Medium | web | Suspected | `useChatSession.ts:455` | S |
| [#156](https://github.com/epittman23/local-llm/issues/156) | A-31 | Telemetry recorder attaches a new run to whatever server already answers on the port | Medium | benchmarks | Suspected | `telemetry_recorder.py:109` | S |
| [#158](https://github.com/epittman23/local-llm/issues/158) | A-33 | Editing a calendar event cannot remove its repeat rule, description or location | Medium | web | Confirmed | `calendarModel.ts:196` | S |
| [#159](https://github.com/epittman23/local-llm/issues/159) | A-34 | Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them | Medium | web | Confirmed | `automationModel.ts:64` | S |
| [#160](https://github.com/epittman23/local-llm/issues/160) | A-35 | Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context | Medium | web | Confirmed | `request.ts:142` | S |
| [#139](https://github.com/epittman23/local-llm/issues/139) | A-14 | A sweep whose baseline fails to load never narrows and does not say why | Low | benchmarks | Suspected | `tune.py:1112` | S |
| [#143](https://github.com/epittman23/local-llm/issues/143) | A-18 | Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success | Low | benchmarks | Confirmed | `index.ts:131` | S |
| [#144](https://github.com/epittman23/local-llm/issues/144) | A-19 | Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune) | Low | benchmarks | Confirmed | `TunePage.tsx:132` | S |
| [#146](https://github.com/epittman23/local-llm/issues/146) | A-21 | make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI | Low | infra | Confirmed | `Makefile:175` | S |
| [#147](https://github.com/epittman23/local-llm/issues/147) | A-22 | make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up | Low | infra | Suspected | `Makefile:145` | S |
| [#148](https://github.com/epittman23/local-llm/issues/148) | A-23 | make backend does not wait for Postgres before the app runs migrations at import | Low | infra | Suspected | `Makefile:92` | S |
| [#149](https://github.com/epittman23/local-llm/issues/149) | A-24 | Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files | Low | docs | Confirmed | `.pre-commit-config.yaml:10` | S |
| [#152](https://github.com/epittman23/local-llm/issues/152) | A-27 | Concurrent archive and set-default can leave the default serving profile archived | Low | benchmarks | Suspected | `profiles.py:341` | S |
| [#153](https://github.com/epittman23/local-llm/issues/153) | A-28 | Concurrent profile create/clone/version edit returns 500 instead of 409 | Low | benchmarks | Suspected | `profiles.py:298` | S |
| [#154](https://github.com/epittman23/local-llm/issues/154) | A-29 | Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating | Low | backend | Suspected | `chats.py:250` | S |
| [#155](https://github.com/epittman23/local-llm/issues/155) | A-30 | Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage | Low | backend | Suspected | `middleware.py:4977` | S |
| [#157](https://github.com/epittman23/local-llm/issues/157) | A-32 | Flaky e2e assertion in the knowledge list search test | Low | web | Suspected | `workspace-knowledge.spec.ts:156` | S |

### Gap review findings (A-36 onward)

| Issue | Finding | Title | Severity | Area | Status | Location | Effort |
|---|---|---|---|---|---|---|---|
| [#241](https://github.com/epittman23/local-llm/issues/241) | A-115 | crypto.randomUUID is unavailable over plain-HTTP LAN access, so sending a chat message throws there | High | web | Confirmed | `history.ts:59` | S |
| [#242](https://github.com/epittman23/local-llm/issues/242) | A-116 | JWT expiry accepts negative durations, locking every user out, and silently drops invalid values while the tab reports saved | High | backend | Confirmed | `auths.py:946` | S |
| [#162](https://github.com/epittman23/local-llm/issues/162) | A-36 | OpenRouter's mid-stream error chunk is ignored, so a cut-off reply is saved and shown as a complete answer | High | backend | Confirmed | `middleware.py:5031` | S |
| [#176](https://github.com/epittman23/local-llm/issues/176) | A-50 | The calendar search tool returns unexpanded recurring events that push real in-range events out of the results | High | backend | Confirmed | `builtin.py:4184` | S |
| [#177](https://github.com/epittman23/local-llm/issues/177) | A-51 | query_chat_files without a file id returns only the first attached file's chunks | High | backend | Confirmed | `builtin.py:2593` | S |
| [#195](https://github.com/epittman23/local-llm/issues/195) | A-69 | Deleting a knowledge directory with its contents leaves the files' chunks in the vector collection, so chat keeps answering from deleted files | High | backend | Confirmed | `knowledge.py:1003` | M |
| [#211](https://github.com/epittman23/local-llm/issues/211) | A-85 | Editing a reply or "Save As Copy" changes only what is displayed; the model keeps receiving the original text | High | web | Confirmed | `history.ts:470` | S |
| [#221](https://github.com/epittman23/local-llm/issues/221) | A-95 | Saving a prompt with "Set as Production" unchecked still puts the new content live | High | backend | Confirmed | `prompts.py:509` | S |
| [#226](https://github.com/epittman23/local-llm/issues/226) | A-100 | Editing any prompt suggestion truncates all others to 2000 characters and drops their other fields | Medium | web | Confirmed | `PromptSuggestionsEditor.tsx:8` | S |
| [#227](https://github.com/epittman23/local-llm/issues/227) | A-101 | Saving a skill re-enables it if disabled and clears its tags | Medium | web | Confirmed | `SkillEditor.tsx:79` | S |
| [#228](https://github.com/epittman23/local-llm/issues/228) | A-102 | Debounced autosaves are cancelled on unmount, so edits made just before leaving a page are lost | Medium | web | Confirmed | `PromptEditView.tsx:76` | S |
| [#229](https://github.com/epittman23/local-llm/issues/229) | A-103 | Knowledge-base actions can leave the user on an empty later page with no pagination to get back | Medium | web | Confirmed | `KnowledgeBasePage.tsx:215` | S |
| [#231](https://github.com/epittman23/local-llm/issues/231) | A-105 | Dropping a folder together with other items skips every item after the first folder | Medium | web | Suspected | `KnowledgeBasePage.tsx:286` | S |
| [#232](https://github.com/epittman23/local-llm/issues/232) | A-106 | Hybrid search is silently switched off when the reranker fails to load, while Documents reports it saved and on | Medium | backend | Confirmed | `retrieval.py:164` | S |
| [#235](https://github.com/epittman23/local-llm/issues/235) | A-109 | Admin Documents accepts chunk size 0 or an overlap larger than the chunk size, after which every upload fails | Medium | web | Confirmed | `Documents.tsx:258` | S |
| [#240](https://github.com/epittman23/local-llm/issues/240) | A-114 | API client helpers resolve null on network or non-JSON errors, so failures are reported as success or lost silently | Medium | web | Confirmed | `index.ts:389` | M |
| [#243](https://github.com/epittman23/local-llm/issues/243) | A-117 | Admin banners are saved but never displayed anywhere (the port lost the banner display and dismissal) | Medium | web | Confirmed | `General.tsx:151` | M |
| [#244](https://github.com/epittman23/local-llm/issues/244) | A-118 | Cancelling an Ollama pull deletes an installed model of the same name | Medium | web | Confirmed | `ollamaDownloads.ts:113` | S |
| [#245](https://github.com/epittman23/local-llm/issues/245) | A-119 | An Ollama pull whose stream errors spins forever and freezes the admin tab | Medium | web | Confirmed | `ollamaDownloads.ts:81` | S |
| [#247](https://github.com/epittman23/local-llm/issues/247) | A-121 | Clearing the Jupyter timeout in admin Code Execution makes the tab unsaveable | Medium | web | Confirmed | `CodeExecution.tsx:110` | S |
| [#252](https://github.com/epittman23/local-llm/issues/252) | A-126 | Failed channel message edits, pins, reactions and deletes stay on screen as if saved | Medium | web | Confirmed | `useMessageFeed.ts:211` | S |
| [#253](https://github.com/epittman23/local-llm/issues/253) | A-127 | A failed channel history load is shown as "the very beginning of the channel" | Medium | web | Confirmed | `useMessageFeed.ts:76` | S |
| [#259](https://github.com/epittman23/local-llm/issues/259) | A-133 | Account tab: a failed load is silent, and Save then wipes user variables and profile fields | Medium | web | Confirmed | `Account.tsx:79` | S |
| [#264](https://github.com/epittman23/local-llm/issues/264) | A-138 | Automation runs are recorded as successful as soon as they are dispatched, so model and provider failures never reach the run history | Medium | backend | Confirmed | `automations.py:468` | M |
| [#265](https://github.com/epittman23/local-llm/issues/265) | A-139 | Automation runs fired before the model list is loaded drop the model's default tools, filters, features and terminal | Medium | backend | Confirmed | `automations.py:308` | S |
| [#266](https://github.com/epittman23/local-llm/issues/266) | A-140 | Daily, weekly and monthly automation rules skip occurrences when the user's timezone is behind the server's, and fire a few seconds late | Medium | backend | Confirmed | `automations.py:84` | S |
| [#268](https://github.com/epittman23/local-llm/issues/268) | A-142 | The app has no handler for the calendar:alert socket event, so in-app calendar reminders are never shown | Medium | web | Confirmed | `automations.py:736` | S |
| [#277](https://github.com/epittman23/local-llm/issues/277) | A-151 | Deleting a thread's parent message leaves its replies, pins and reactions reachable | Medium | backend | Confirmed | `messages.py:574` | S |
| [#278](https://github.com/epittman23/local-llm/issues/278) | A-152 | Leaderboard counts a thumbs-up on a regenerated reply as both a win and a loss for the same model | Medium | backend | Confirmed | `evaluations.py:111` | S |
| [#282](https://github.com/epittman23/local-llm/issues/282) | A-156 | Batch memory replace clears the memory's path unless the caller repeats it | Medium | backend | Confirmed | `memory.py:264` | S |
| [#283](https://github.com/epittman23/local-llm/issues/283) | A-157 | Generated tags that differ only by case or spacing make the whole tag batch fail, leaving chat tags unindexed and unarchive returning 500 | Medium | backend | Confirmed | `tags.py:121` | S |
| [#284](https://github.com/epittman23/local-llm/issues/284) | A-158 | Every failed OAuth token refresh deletes the session, and refresh has no lock despite its docstring | Medium | backend | Confirmed | `oauth.py:1055` | S |
| [#289](https://github.com/epittman23/local-llm/issues/289) | A-163 | Postgres chat search silently excludes chats whose title contains "x00" or whose content contains a literal \u0000 | Medium | backend | Confirmed | `chats.py:2066` | S |
| [#290](https://github.com/epittman23/local-llm/issues/290) | A-164 | Files added to a message by tools or streamed images are written only to the chat JSON, so they are duplicated on save and lost on fork | Medium | backend | Confirmed | `chats.py:1201` | S |
| [#163](https://github.com/epittman23/local-llm/issues/163) | A-37 | If the upstream connection drops mid-stream, the partial reply is discarded and the stream snapshot is never cleared | Medium | backend | Confirmed | `middleware.py:4859` | S |
| [#164](https://github.com/epittman23/local-llm/issues/164) | A-38 | Resuming after a tool approval rebuilds messages from the database, dropping the system prompt, injected context and the user's images | Medium | backend | Confirmed | `middleware.py:3438` | M |
| [#165](https://github.com/epittman23/local-llm/issues/165) | A-39 | A non-streaming reply with only tool calls, or with empty content, is never finished and spins forever | Medium | backend | Confirmed | `middleware.py:4139` | S |
| [#169](https://github.com/epittman23/local-llm/issues/169) | A-43 | Connected MCP clients leak when listing tools fails or a later tool-setup step raises | Medium | backend | Suspected | `middleware.py:2260` | S |
| [#170](https://github.com/epittman23/local-llm/issues/170) | A-44 | One failing notification webhook stops delivery to the user's other notification targets | Medium | backend | Confirmed | `notifications.py:395` | S |
| [#171](https://github.com/epittman23/local-llm/issues/171) | A-45 | Recurring calendar occurrences that start before the viewed range are dropped, unlike one-off events with the same times | Medium | backend | Confirmed | `calendar.py:44` | S |
| [#178](https://github.com/epittman23/local-llm/issues/178) | A-52 | Paging view_file / view_knowledge_file with line numbers skips content | Medium | backend | Confirmed | `builtin.py:2820` | S |
| [#179](https://github.com/epittman23/local-llm/issues/179) | A-53 | query_knowledge_files lets attached notes and internal hits crowd out more relevant external knowledge hits | Medium | backend | Confirmed | `builtin.py:3357` | S |
| [#180](https://github.com/epittman23/local-llm/issues/180) | A-54 | One failing external knowledge base makes query_knowledge_files fail and discards every internal result | Medium | backend | Confirmed | `builtin.py:3369` | S |
| [#181](https://github.com/epittman23/local-llm/issues/181) | A-55 | search_notes and search_chats apply date filters after fetching only the newest matches, so older ranges return nothing | Medium | backend | Confirmed | `builtin.py:1153` | M |
| [#182](https://github.com/epittman23/local-llm/issues/182) | A-56 | Creating an event without a calendar picks the first shared calendar flagged default, which can be another user's | Medium | backend | Confirmed | `builtin.py:4277` | S |
| [#183](https://github.com/epittman23/local-llm/issues/183) | A-57 | Rescheduling an event never re-arms its reminder, and recurring events alert only once | Medium | backend | Confirmed | `builtin.py:4446` | S |
| [#187](https://github.com/epittman23/local-llm/issues/187) | A-61 | merge_system_messages keeps only the first text part of a list-content system message | Medium | backend | Confirmed | `misc.py:641` | S |
| [#188](https://github.com/epittman23/local-llm/issues/188) | A-62 | The Anthropic-compatible endpoint reports upstream failures as a successful end_turn | Medium | backend | Confirmed | `anthropic.py:526` | S |
| [#189](https://github.com/epittman23/local-llm/issues/189) | A-63 | OpenAPI tool servers: body fields that share a name with a path or query parameter are removed from the body (regression from #117) | Medium | backend | Confirmed | `tools.py:1769` | M |
| [#196](https://github.com/epittman23/local-llm/issues/196) | A-70 | Every chat save re-adds a continued reply's usage to its chat_message row, inflating stored token usage without bound | Medium | backend | Confirmed | `chat_messages.py:243` | S |
| [#197](https://github.com/epittman23/local-llm/issues/197) | A-71 | The Knowledge page's "local" source filter matches no knowledge base created in the app | Medium | backend | Confirmed | `knowledge.py:206` | S |
| [#200](https://github.com/epittman23/local-llm/issues/200) | A-74 | Clearing a custom number parameter in chat controls stores "" and every later request sends it upstream as the value | Medium | web | Confirmed | `AdvancedParams.tsx:49` | S |
| [#202](https://github.com/epittman23/local-llm/issues/202) | A-76 | The note access dialog lost the original's permission props: no write grants, and a Public option that is silently stripped while the UI shows it applied | Medium | web | Confirmed | `NoteEditorPage.tsx:200` | S |
| [#203](https://github.com/epittman23/local-llm/issues/203) | A-77 | Leaderboard Elo ratings depend on database row order rather than time | Medium | backend | Confirmed | `feedbacks.py:315` | S |
| [#212](https://github.com/epittman23/local-llm/issues/212) | A-86 | With the message queue off, sending while a reply streams does not stop that reply | Medium | web | Confirmed | `useChatSession.ts:436` | S |
| [#213](https://github.com/epittman23/local-llm/issues/213) | A-87 | A queued prompt is silently discarded when the reply it waited for fails with no content | Medium | web | Confirmed | `useChatSession.ts:447` | S |
| [#214](https://github.com/epittman23/local-llm/issues/214) | A-88 | A reply whose done event was missed (socket drop, sleep, backend reload) stays "generating" forever | Medium | web | Confirmed | `history.ts:292` | M |
| [#215](https://github.com/epittman23/local-llm/issues/215) | A-89 | An async message action or rating that finishes while another chat loads saves the old chat's history into the new chat | Medium | web | Confirmed | `useChatSession.ts:618` | S |
| [#224](https://github.com/epittman23/local-llm/issues/224) | A-98 | Importing a model JSON over an existing model deletes its sharing grants, re-enables it, and replaces its meta | Medium | web | Confirmed | `ModelsPage.tsx:285` | S |
| [#225](https://github.com/epittman23/local-llm/issues/225) | A-99 | Bulk Enable/Disable/Show/Hide on the Models page act on read-only models and can wipe their params | Medium | web | Confirmed | `ModelsPage.tsx:239` | S |
| [#230](https://github.com/epittman23/local-llm/issues/230) | A-104 | The knowledge base detail page starts filtered by the list pages' shared View setting | Low | web | Confirmed | `KnowledgeBasePage.tsx:150` | S |
| [#233](https://github.com/epittman23/local-llm/issues/233) | A-107 | Admin Documents: the BM25 weight "Default" option can never be saved | Low | web | Confirmed | `Documents.tsx:594` | S |
| [#234](https://github.com/epittman23/local-llm/issues/234) | A-108 | Admin Documents: JSON options pass validation then fail the save after the embedding change was already applied | Low | web | Confirmed | `documents.ts:50` | S |
| [#236](https://github.com/epittman23/local-llm/issues/236) | A-110 | Admin Images: Verify for the edit ComfyUI URL checks the generation server instead | Low | web | Confirmed | `Images.tsx:269` | S |
| [#237](https://github.com/epittman23/local-llm/issues/237) | A-111 | Admin Images: a cleared Steps field is sent as "" and fails the whole save | Low | web | Confirmed | `Images.tsx:371` | S |
| [#238](https://github.com/epittman23/local-llm/issues/238) | A-112 | "Max Upload Size" 0 means unlimited to the server but rejects every file in the chat and channel composers | Low | web | Confirmed | `Documents.tsx:661` | S |
| [#239](https://github.com/epittman23/local-llm/issues/239) | A-113 | Admin Connections Save shows "Settings saved" after both saves failed | Low | web | Confirmed | `Connections.tsx:247` | S |
| [#246](https://github.com/epittman23/local-llm/issues/246) | A-120 | Ollama "Update All Models" reports success even when every pull failed | Low | web | Confirmed | `ManageOllama.tsx:164` | S |
| [#248](https://github.com/epittman23/local-llm/issues/248) | A-122 | Clearing number fields in admin Interface settings fails the save and can half-apply it | Low | web | Confirmed | `Interface.tsx:122` | S |
| [#249](https://github.com/epittman23/local-llm/issues/249) | A-123 | After hiding a connection model with no stored record, further toggles on it fail until the tab is reopened | Low | web | Confirmed | `AdminModels.tsx:228` | S |
| [#250](https://github.com/epittman23/local-llm/issues/250) | A-124 | GGUF upload creates the model twice in file mode and never in URL mode, and stream errors are swallowed | Low | web | Suspected | `ManageOllama.tsx:259` | S |
| [#251](https://github.com/epittman23/local-llm/issues/251) | A-125 | Pipelines: an unset list valve loads as an empty required Custom field, blocking Save; its test cannot catch it | Low | web | Confirmed | `pipelineValves.ts:10` | S |
| [#254](https://github.com/epittman23/local-llm/issues/254) | A-128 | Every open tab shows its own desktop notification and sound for each channel message | Low | web | Confirmed | `useChannels.ts:117` | S |
| [#255](https://github.com/epittman23/local-llm/issues/255) | A-129 | Channel unread badges count thread replies and model replies that the server does not count | Low | web | Confirmed | `channelModel.ts:410` | S |
| [#256](https://github.com/epittman23/local-llm/issues/256) | A-130 | Pressing Enter on a mention suggestion that dropped out of the list throws and inserts nothing | Low | web | Confirmed | `MessageComposer.tsx:143` | S |
| [#257](https://github.com/epittman23/local-llm/issues/257) | A-131 | The reaction tooltip omits the fourth person when exactly four users reacted | Low | web | Confirmed | `channelModel.ts:486` | S |
| [#258](https://github.com/epittman23/local-llm/issues/258) | A-132 | The pure-JS SHA-256 fallback is wrong for files of 512 MiB or more, so knowledge sync re-uploads them every time over plain HTTP | Low | web | Confirmed | `hash.ts:167` | S |
| [#260](https://github.com/epittman23/local-llm/issues/260) | A-134 | Enter in a password field on the Account tab runs the profile save instead of the password change | Low | web | Confirmed | `Account.tsx:292` | S |
| [#261](https://github.com/epittman23/local-llm/issues/261) | A-135 | A font typed and submitted with Enter on the Interface tab is not saved | Low | web | Confirmed | `InterfaceSettings.tsx:266` | S |
| [#262](https://github.com/epittman23/local-llm/issues/262) | A-136 | Personal settings switches fail silently, and the interface permission blocks every settings save while only one tab is hidden | Low | web | Confirmed | `Audio.tsx:118` | S |
| [#263](https://github.com/epittman23/local-llm/issues/263) | A-137 | A personal tool server saved without a name is listed as a blank row | Low | web | Confirmed | `Integrations.tsx:60` | S |
| [#267](https://github.com/epittman23/local-llm/issues/267) | A-141 | Sub-daily rules with an old DTSTART are rebuilt from the epoch, reviving exhausted COUNT rules and shifting run times | Low | backend | Confirmed | `automations.py:109` | S |
| [#269](https://github.com/epittman23/local-llm/issues/269) | A-143 | Plugin import rewriting matches substrings, corrupting imports such as configparser and saving the corrupted source | Low | backend | Confirmed | `plugin.py:228` | S |
| [#270](https://github.com/epittman23/local-llm/issues/270) | A-144 | A chat timer stays "running" forever if anything fails before completion or the process restarts mid-claim | Low | backend | Confirmed | `timers.py:171` | S |
| [#271](https://github.com/epittman23/local-llm/issues/271) | A-145 | The stop-sequence mapping corrupts non-ASCII stop strings and splits a string stop into characters | Low | backend | Confirmed | `payload.py:191` | S |
| [#272](https://github.com/epittman23/local-llm/issues/272) | A-146 | With default model metadata set, admins lose base models that have no workspace row when admin bypass is off | Low | backend | Confirmed | `models.py:297` | S |
| [#273](https://github.com/epittman23/local-llm/issues/273) | A-147 | MCP OAuth client registration picks a token auth method the client cannot use | Low | backend | Confirmed | `oauth.py:541` | S |
| [#274](https://github.com/epittman23/local-llm/issues/274) | A-148 | OAuth groups in a dotted claim name (Auth0-style URL claims) never resolve | Low | backend | Confirmed | `oauth.py:1948` | S |
| [#275](https://github.com/epittman23/local-llm/issues/275) | A-149 | OAuth group sync removes a new user from the default group immediately after adding them | Low | backend | Confirmed | `oauth.py:2023` | S |
| [#276](https://github.com/epittman23/local-llm/issues/276) | A-150 | kb_exec ls lists a model's directly attached files inside every knowledge base | Low | backend | Confirmed | `knowledge_fs.py:402` | S |
| [#279](https://github.com/epittman23/local-llm/issues/279) | A-153 | Adding several users to a group silently drops new members when one is already a member | Low | backend | Confirmed | `groups.py:586` | S |
| [#280](https://github.com/epittman23/local-llm/issues/280) | A-154 | The workspace model tag filter matches models whose meta merely contains the tag word | Low | backend | Confirmed | `models.py:387` | S |
| [#281](https://github.com/epittman23/local-llm/issues/281) | A-155 | Folder delete commits child deletions one by one and reports a mid-way failure as success | Low | backend | Suspected | `folders.py:394` | S |
| [#285](https://github.com/epittman23/local-llm/issues/285) | A-159 | Non-expiring OAuth tokens become unusable on servers east of UTC | Low | backend | Confirmed | `oauth.py:201` | S |
| [#286](https://github.com/epittman23/local-llm/issues/286) | A-160 | OAuth provider settings saved in Admin > Authentication are never used for login | Low | backend | Confirmed | `auths.py:1037` | S |
| [#287](https://github.com/epittman23/local-llm/issues/287) | A-161 | A 44-character LLLM_SECRET_KEY that is not a Fernet key stops the backend from starting | Low | backend | Confirmed | `oauth_sessions.py:72` | S |
| [#288](https://github.com/epittman23/local-llm/issues/288) | A-162 | Tool valve saves report success when the database write failed | Low | backend | Confirmed | `tools.py:257` | S |
| [#291](https://github.com/epittman23/local-llm/issues/291) | A-165 | Chat search ignores a folder: filter that matches no folder and returns every chat | Low | backend | Confirmed | `chats.py:1953` | S |
| [#292](https://github.com/epittman23/local-llm/issues/292) | A-166 | LIKE wildcards in chat search text are not escaped, so % or _ matches every chat | Low | backend | Confirmed | `chats.py:2016` | S |
| [#293](https://github.com/epittman23/local-llm/issues/293) | A-167 | Linking an already-linked file to a chat makes the whole chat_file batch fail, so new files are never linked | Low | backend | Confirmed | `chats.py:2549` | S |
| [#294](https://github.com/epittman23/local-llm/issues/294) | A-168 | Chat export pages by OFFSET over updated_at, so a chat updated during export is skipped and another exported twice | Low | backend | Confirmed | `chats.py:1845` | S |
| [#295](https://github.com/epittman23/local-llm/issues/295) | A-169 | Imported chats all show as unread | Low | backend | Confirmed | `chats.py:601` | S |
| [#166](https://github.com/epittman23/local-llm/issues/166) | A-40 | Tool arguments that are valid JSON but not an object crash the whole reply | Low | backend | Confirmed | `middleware.py:4645` | S |
| [#167](https://github.com/epittman23/local-llm/issues/167) | A-41 | A Responses API `response.failed` event is shown live but not saved, so the reply looks successful after reload | Low | backend | Confirmed | `middleware.py:4980` | S |
| [#168](https://github.com/epittman23/local-llm/issues/168) | A-42 | Task-model JSON is located with rfind('{'), so generated search queries or prompts containing a brace are mangled | Low | backend | Confirmed | `middleware.py:1438` | S |
| [#172](https://github.com/epittman23/local-llm/issues/172) | A-46 | One invalid chat-variable value silently blanks every chat variable in the system prompt | Low | backend | Confirmed | `chat_variables.py:243` | S |
| [#173](https://github.com/epittman23/local-llm/issues/173) | A-47 | A filter's user valves leak to later filters through the shared `__user__` dict | Low | backend | Confirmed | `filter.py:135` | S |
| [#174](https://github.com/epittman23/local-llm/issues/174) | A-48 | Resolving a tool approval twice can run the tool twice | Low | backend | Suspected | `tool_approval.py:55` | S |
| [#175](https://github.com/epittman23/local-llm/issues/175) | A-49 | Custom connection headers with user-name or file-name placeholders break MCP connections for non-ASCII values | Low | backend | Confirmed | `headers.py:137` | S |
| [#184](https://github.com/epittman23/local-llm/issues/184) | A-58 | Calendar reminders longer than 60 minutes fire 60 minutes before, although the tool offers them | Low | backend | Confirmed | `builtin.py:4389` | S |
| [#185](https://github.com/epittman23/local-llm/issues/185) | A-59 | view_channel_thread returns user_name null for every reply not posted by a webhook | Low | backend | Confirmed | `builtin.py:2003` | S |
| [#186](https://github.com/epittman23/local-llm/issues/186) | A-60 | Knowledge listing tools load every file's full text just to count files | Low | backend | Confirmed | `builtin.py:2075` | S |
| [#190](https://github.com/epittman23/local-llm/issues/190) | A-64 | OpenAPI tool servers: header and cookie parameters are offered to the model but never sent | Low | backend | Confirmed | `tools.py:1180` | M |
| [#191](https://github.com/epittman23/local-llm/issues/191) | A-65 | OpenAPI tool servers: an operation whose JSON body is an array produces an unusable tool | Low | backend | Confirmed | `tools.py:1220` | M |
| [#192](https://github.com/epittman23/local-llm/issues/192) | A-66 | Without Redis, every tool-server and terminal-server lookup refetches every server spec | Low | backend | Confirmed | `tools.py:1246` | S |
| [#193](https://github.com/epittman23/local-llm/issues/193) | A-67 | Sub-agent limit -1 ("unlimited") breaks max_iterations and max_output | Low | backend | Confirmed | `subagents.py:271` | S |
| [#194](https://github.com/epittman23/local-llm/issues/194) | A-68 | Anthropic-to-OpenAI conversion drops top-level document and search_result blocks and ignores tool_choice none | Low | backend | Confirmed | `anthropic.py:255` | S |
| [#198](https://github.com/epittman23/local-llm/issues/198) | A-72 | The Analytics 24-hour chart ignores the group filter | Low | backend | Confirmed | `analytics.py:208` | S |
| [#199](https://github.com/epittman23/local-llm/issues/199) | A-73 | Paginated listings (users, group members, models, feedback) have no deterministic ORDER BY, so pages can repeat or skip rows | Low | backend | Suspected | `users.py:331` | S |
| [#201](https://github.com/epittman23/local-llm/issues/201) | A-75 | A numeric enum valve sends its option as a string, so the backend rejects the save | Low | web | Confirmed | `Valves.tsx:111` | S |
| [#204](https://github.com/epittman23/local-llm/issues/204) | A-78 | Topic-weighted Elo uses raw cosine similarity, so a negative weight reverses a result | Low | backend | Suspected | `evaluations.py:109` | S |
| [#205](https://github.com/epittman23/local-llm/issues/205) | A-79 | Sorting the Feedback table by User sends a key the backend ignores, leaving pages unordered | Low | web | Confirmed | `Feedbacks.tsx:35` | S |
| [#206](https://github.com/epittman23/local-llm/issues/206) | A-80 | A ?redirect= value with a control character passes safeRedirect, and the signed-in user is left on the sign-in form | Low | web | Confirmed | `redirect.ts:8` | S |
| [#207](https://github.com/epittman23/local-llm/issues/207) | A-81 | Playground Cancel and leaving the page cannot abort a request before response headers arrive | Low | web | Confirmed | `PlaygroundPages.tsx:114` | S |
| [#208](https://github.com/epittman23/local-llm/issues/208) | A-82 | Playground parameters are spread at the top level of the request, so custom parameters never apply and app-only keys reach the provider | Low | web | Confirmed | `playgroundModel.ts:66` | S |
| [#209](https://github.com/epittman23/local-llm/issues/209) | A-83 | Functions "Import JSON" reports success even when every create failed | Low | web | Confirmed | `FunctionsPage.tsx:207` | S |
| [#210](https://github.com/epittman23/local-llm/issues/210) | A-84 | A /notes?title=&content= link whose note creation fails leaves an endless spinner | Low | web | Confirmed | `NotesPage.tsx:74` | S |
| [#216](https://github.com/epittman23/local-llm/issues/216) | A-90 | When the request fails in a multi-model chat, only the first column is marked failed and the input stays generating | Low | web | Confirmed | `useChatSession.ts:359` | S |
| [#217](https://github.com/epittman23/local-llm/issues/217) | A-91 | Attachments and the typed draft carry over when switching chats | Low | web | Confirmed | `useAttachments.ts:68` | S |
| [#218](https://github.com/epittman23/local-llm/issues/218) | A-92 | Queued prompts are discarded when switching chats | Low | web | Confirmed | `useChatSession.ts:221` | S |
| [#219](https://github.com/epittman23/local-llm/issues/219) | A-93 | Image uploads to a non-vision model are no longer refused | Low | web | Confirmed | `useAttachments.ts:201` | S |
| [#220](https://github.com/epittman23/local-llm/issues/220) | A-94 | HEIC images are uploaded unconverted | Low | web | Confirmed | `useAttachments.ts:139` | S |
| [#222](https://github.com/epittman23/local-llm/issues/222) | A-96 | Switching the production prompt version reverts name and tags edited through the metadata path | Low | backend | Confirmed | `prompts.py:556` | S |
| [#223](https://github.com/epittman23/local-llm/issues/223) | A-97 | The prompt version diff endpoint is unreachable | Low | backend | Confirmed | `prompts.py:636` | S |

### Final review wave findings (A-170 onward)

| Issue | Finding | Title | Severity | Area | Status | Location | Effort |
|---|---|---|---|---|---|---|---|
| [#297](https://github.com/epittman23/local-llm/issues/297) | A-171 | With LLLM_BACKEND_HOST=0.0.0.0, Socket.IO refuses every connection from a LAN origin, so chat replies never reach the page | High | infra | Confirmed | `Makefile:101` | S |
| [#307](https://github.com/epittman23/local-llm/issues/307) | A-181 | Saving a knowledge file's edited content reports success when nothing, or only part of it, was saved | High | backend | Confirmed | `files.py:718` | M |
| [#318](https://github.com/epittman23/local-llm/issues/318) | A-192 | Saving any occurrence of a repeating calendar event moves the whole series to start there; deleting an occurrence deletes the series | High | web | Confirmed | `CalendarPage.tsx:198` | S |
| [#327](https://github.com/epittman23/local-llm/issues/327) | A-201 | Direct-message and group channel messages never send channel.message notifications | High | backend | Confirmed | `channels.py:81` | S |
| [#340](https://github.com/epittman23/local-llm/issues/340) | A-214 | A model downloaded by URL is hashed and pushed to Ollama before its last bytes are flushed, so a truncated blob is reported as done | High | backend | Confirmed | `ollama.py:1576` | S |
| [#298](https://github.com/epittman23/local-llm/issues/298) | A-172 | Stopping a chat's tasks skips some when three or more are running, but reports all stopped | Medium | backend | Confirmed | `tasks.py:114` | S |
| [#302](https://github.com/epittman23/local-llm/issues/302) | A-176 | A function edit whose code fails to load switches off the live function while the API reports the update was rejected | Medium | backend | Confirmed | `functions.py:391` | S |
| [#303](https://github.com/epittman23/local-llm/issues/303) | A-177 | Memory routes write the database before embedding, so a failed embedding leaves stale or missing memories in chat context | Medium | backend | Confirmed | `memories.py:136` | M |
| [#308](https://github.com/epittman23/local-llm/issues/308) | A-182 | "Reindex knowledge" deletes every vector up front and reports success even when files fail to re-embed | Medium | backend | Confirmed | `knowledge.py:380` | S |
| [#309](https://github.com/epittman23/local-llm/issues/309) | A-183 | Knowledge files whose processing is interrupted stay "uploading" forever | Medium | backend | Confirmed | `files.py:226` | S |
| [#310](https://github.com/epittman23/local-llm/issues/310) | A-184 | A failed knowledge-base step leaves an orphan file, so folder sync leaks a file on every run for identical-content files | Medium | backend | Confirmed | `files.py:191` | S |
| [#319](https://github.com/epittman23/local-llm/issues/319) | A-193 | Calendar day and week views show an event only in its starting hour, so multi-day and all-day events vanish on later days | Medium | web | Confirmed | `CalendarViews.tsx:166` | S |
| [#320](https://github.com/epittman23/local-llm/issues/320) | A-194 | Clicking a channel automation's run in the calendar opens /c/channel:<id>, which bounces to a blank chat | Medium | web | Confirmed | `calendarModel.ts:216` | S |
| [#328](https://github.com/epittman23/local-llm/issues/328) | A-202 | In channel (inline) response mode the model gets no conversation context, not even the message being replied to | Medium | backend | Confirmed | `channels.py:983` | S |
| [#329](https://github.com/epittman23/local-llm/issues/329) | A-203 | A channel model reply stays on "Thinking" forever when the completion fails before its task starts or ends with no text | Medium | backend | Confirmed | `channels.py:1021` | S |
| [#334](https://github.com/epittman23/local-llm/issues/334) | A-208 | Share links open only for the owner and admins: the React share dialog lost the access-control panel | Medium | web | Confirmed | `ChatDialogs.tsx:38` | S |
| [#335](https://github.com/epittman23/local-llm/issues/335) | A-209 | Saving a model, prompt or skill as a non-admin strips existing public, user or group grants | Medium | backend | Confirmed | `models.py:824` | S |
| [#336](https://github.com/epittman23/local-llm/issues/336) | A-210 | Cloning or sharing a chat while a reply streams copies the unfinished placeholder (fork is guarded, clone and share are not) | Medium | backend | Confirmed | `chats.py:1462` | S |
| [#341](https://github.com/epittman23/local-llm/issues/341) | A-215 | URL model downloads ignore the HTTP status, resume blindly, and are capped at 10 minutes (30 s for the push) | Medium | backend | Confirmed | `ollama.py:1564` | M |
| [#342](https://github.com/epittman23/local-llm/issues/342) | A-216 | Saving Admin > Audio with local Whisper fails after persisting whenever the model cannot load, and the page shows nothing | Medium | backend | Confirmed | `audio.py:211` | S |
| [#343](https://github.com/epittman23/local-llm/issues/343) | A-217 | With the "Web API" speech-to-text engine selected, every uploaded audio file fails processing with a TypeError | Medium | backend | Confirmed | `audio.py:906` | S |
| [#346](https://github.com/epittman23/local-llm/issues/346) | A-220 | An embedding model that fails to load is saved and reported as updated, after which every upload and query fails | Medium | backend | Confirmed | `retrieval.py:141` | S |
| [#347](https://github.com/epittman23/local-llm/issues/347) | A-221 | Native pgvector hybrid search requires every query word to match, so keyword ranking rarely contributes and weight 1.0 returns nothing | Medium | backend | Confirmed | `pgvector.py:566` | S |
| [#348](https://github.com/epittman23/local-llm/issues/348) | A-222 | The external reranker has no default timeout, and its failures silently skip reranking, top-k and the relevance threshold | Medium | backend | Confirmed | `external.py:253` | S |
| [#349](https://github.com/epittman23/local-llm/issues/349) | A-223 | External knowledge bases answer only the first of several generated queries | Medium | backend | Confirmed | `external.py:327` | S |
| [#350](https://github.com/epittman23/local-llm/issues/350) | A-224 | The external pgvector provider sends the query vector as double precision[], so queries likely fail | Medium | backend | Suspected | `external.py:233` | S |
| [#351](https://github.com/epittman23/local-llm/issues/351) | A-225 | In chat, one failing attachment or external knowledge base silently drops the context of every attachment | Medium | backend | Confirmed | `utils.py:1530` | S |
| [#352](https://github.com/epittman23/local-llm/issues/352) | A-226 | pgvector query, get and search leave the thread's session in an open transaction when nothing matches | Medium | backend | Confirmed | `pgvector.py:522` | S |
| [#359](https://github.com/epittman23/local-llm/issues/359) | A-233 | In multi-model chats every column after the first runs with the first model's parameters and system prompt state | Medium | backend | Confirmed | `main.py:1085` | S |
| [#360](https://github.com/epittman23/local-llm/issues/360) | A-234 | The custom-model fallback setting does nothing for UI chats, because the fan-out restores the broken model | Medium | backend | Confirmed | `main.py:1698` | S |
| [#361](https://github.com/epittman23/local-llm/issues/361) | A-235 | SAFE_MODE does not stop event functions from running at startup | Medium | backend | Confirmed | `main.py:341` | S |
| [#362](https://github.com/epittman23/local-llm/issues/362) | A-236 | Shutdown closes the HTTP pool without stopping running chat tasks, so in-flight replies are cut instead of saved as cancelled | Medium | backend | Suspected | `main.py:430` | S |
| [#296](https://github.com/epittman23/local-llm/issues/296) | A-170 | Admin password reset for a SCIM-created user silently does nothing but reports success | Low | backend | Confirmed | `scim.py:614` | S |
| [#299](https://github.com/epittman23/local-llm/issues/299) | A-173 | The default avatar endpoint returns 500 because user.png is never seeded into the static directory | Low | backend | Confirmed | `users.py:876` | S |
| [#300](https://github.com/epittman23/local-llm/issues/300) | A-174 | /openai/audio/speech returns 500 because an error-message function is passed uncalled | Low | backend | Confirmed | `openai.py:612` | S |
| [#301](https://github.com/epittman23/local-llm/issues/301) | A-175 | An empty RAG_FILE_MAX_SIZE crashes startup, and the metadata cap ignores the admin upload limit | Low | backend | Confirmed | `env.py:745` | S |
| [#304](https://github.com/epittman23/local-llm/issues/304) | A-178 | The Pipelines server's error details never reach the client, and valve reads publish a valves-updated event while updates publish none | Low | backend | Confirmed | `pipelines.py:92` | S |
| [#305](https://github.com/epittman23/local-llm/issues/305) | A-179 | Task prompt templates re-expand template variables inside the user's own messages | Low | backend | Confirmed | `task.py:331` | S |
| [#306](https://github.com/epittman23/local-llm/issues/306) | A-180 | generateTags turns every apostrophe into a double quote before parsing, so one tag with an apostrophe empties the list | Low | web | Confirmed | `index.ts:853` | S |
| [#311](https://github.com/epittman23/local-llm/issues/311) | A-185 | The upload status stream can report completed before the knowledge-base step and link finish | Low | backend | Suspected | `retrieval.py:2054` | S |
| [#312](https://github.com/epittman23/local-llm/issues/312) | A-186 | Knowledge directories at the root can share a name, and sync then ignores one of them | Low | backend | Confirmed | `knowledge.py:74` | S |
| [#313](https://github.com/epittman23/local-llm/issues/313) | A-187 | Removing a file from one knowledge base (or resetting one) deletes it even when another base uses it | Low | backend | Confirmed | `knowledge.py:1656` | S |
| [#314](https://github.com/epittman23/local-llm/issues/314) | A-188 | Adding an already-linked file to a knowledge base duplicates its chunks and reports success; batch-add warnings are dropped | Low | backend | Confirmed | `knowledge.py:1459` | S |
| [#315](https://github.com/epittman23/local-llm/issues/315) | A-189 | Deleting a shared chat folder leaves other users' chats pointing at it, hidden from their sidebars | Low | backend | Confirmed | `folders.py:692` | S |
| [#316](https://github.com/epittman23/local-llm/issues/316) | A-190 | Deleting a folder while keeping its chats still requires the chat delete permission | Low | backend | Confirmed | `folders.py:675` | S |
| [#317](https://github.com/epittman23/local-llm/issues/317) | A-191 | Folder sync removes the old copy of a modified file before the new one has uploaded | Low | web | Confirmed | `useKnowledgeUploads.ts:242` | S |
| [#321](https://github.com/epittman23/local-llm/issues/321) | A-195 | Calendar hour rows mis-bucket events on daylight-saving days: duplicated on spring-forward, missing on fall-back | Low | web | Confirmed | `calendarModel.ts:88` | S |
| [#322](https://github.com/epittman23/local-llm/issues/322) | A-196 | Clearing the time in the automation schedule picker sends BYMINUTE=undefined, or runs a one-time automation at midnight | Low | web | Confirmed | `AutomationDialog.tsx:118` | S |
| [#323](https://github.com/epittman23/local-llm/issues/323) | A-197 | Automation JSON import stops at the first rejected item, keeping earlier items and giving no count | Low | web | Confirmed | `AutomationsPage.tsx:145` | S |
| [#324](https://github.com/epittman23/local-llm/issues/324) | A-198 | Calendar display details: unknown reminder values show as None, month cells are not in time order, paused automations show a next run, and the user timezone is synced only at sign-in | Low | web | Confirmed | `CalendarDialogs.tsx:23` | M |
| [#325](https://github.com/epittman23/local-llm/issues/325) | A-199 | 207 emoji shortcodes (heart, warning, v, point_up, check marks) produce text-style characters without the emoji variation selector | Low | web | Confirmed | `emoji.ts:89` | S |
| [#326](https://github.com/epittman23/local-llm/issues/326) | A-200 | {{USER_LANGUAGE}} is always en-US, and the stored locale is overwritten | Low | web | Confirmed | `index.ts:24` | S |
| [#330](https://github.com/epittman23/local-llm/issues/330) | A-204 | Pinning a webhook message relabels it as the webhook owner, and the pinned list names every webhook "Webhook" | Low | backend | Confirmed | `channels.py:1399` | S |
| [#331](https://github.com/epittman23/local-llm/issues/331) | A-205 | A group channel's Public setting is saved but never enforced | Low | backend | Confirmed | `ChannelDialogs.tsx:689` | S |
| [#332](https://github.com/epittman23/local-llm/issues/332) | A-206 | Note delete reports success when it failed, and a failed pin returns 500 | Low | backend | Confirmed | `notes.py:701` | S |
| [#333](https://github.com/epittman23/local-llm/issues/333) | A-207 | Deleting a channel leaves its messages, reactions, memberships and webhooks; deleting a note leaves its chats | Low | backend | Confirmed | `channels.py:907` | S |
| [#337](https://github.com/epittman23/local-llm/issues/337) | A-211 | POST /models/import reports success when entries were skipped or failed to save | Low | backend | Confirmed | `models.py:418` | S |
| [#338](https://github.com/epittman23/local-llm/issues/338) | A-212 | Deleting another user's chat as an admin runs orphan-tag cleanup against the admin's own tags | Low | backend | Confirmed | `chats.py:1295` | S |
| [#339](https://github.com/epittman23/local-llm/issues/339) | A-213 | Chat search snippets can miss the match when the text contains characters that lengthen when lowercased | Low | backend | Confirmed | `chats.py:175` | S |
| [#344](https://github.com/epittman23/local-llm/issues/344) | A-218 | A malformed image edit size is accepted on save and then makes every image edit fail | Low | backend | Confirmed | `images.py:275` | S |
| [#345](https://github.com/epittman23/local-llm/issues/345) | A-219 | Ollama API proxy routes: prefixed model ids are sent unstripped, an inverted message validator rejects tool-call turns, and failed uploads leave multi-GB files | Low | backend | Confirmed | `ollama.py:433` | S |
| [#353](https://github.com/epittman23/local-llm/issues/353) | A-227 | An embedding batch size of 0 or less is accepted and breaks every embedding | Low | backend | Confirmed | `retrieval.py:509` | S |
| [#354](https://github.com/epittman23/local-llm/issues/354) | A-228 | The collection query API ignores hybrid=false, and r=0 or k_reranker=0 cannot override the configuration | Low | backend | Confirmed | `retrieval.py:2898` | S |
| [#355](https://github.com/epittman23/local-llm/issues/355) | A-229 | Full-context reads of a vector collection return chunks in arbitrary order | Low | backend | Suspected | `pgvector.py:611` | S |
| [#356](https://github.com/epittman23/local-llm/issues/356) | A-230 | The Scheduled Tasks calendar shows runs that will never happen for COUNT rules | Low | backend | Confirmed | `calendar.py:209` | S |
| [#357](https://github.com/epittman23/local-llm/issues/357) | A-231 | With enriched texts on, hybrid search returns the BM25 scoring text as the chunk content | Low | backend | Confirmed | `utils.py:540` | S |
| [#358](https://github.com/epittman23/local-llm/issues/358) | A-232 | Notes shared through a readable folder are left out of RAG, unlike files and knowledge bases in the same folder | Low | backend | Confirmed | `utils.py:1392` | S |
| [#363](https://github.com/epittman23/local-llm/issues/363) | A-237 | A tool-server connection saved with config null stops the backend from starting | Low | backend | Confirmed | `main.py:559` | S |
| [#364](https://github.com/epittman23/local-llm/issues/364) | A-238 | Upstream failures on the direct API path all become HTTP 400 | Low | backend | Confirmed | `main.py:1637` | S |

## 3. Execution order

Batches are ordered by dependency first and severity second. One branch and one pull request per batch (a batch may be split into consecutive PRs where noted).

Recommended sequence: **B0**, then **B12** (it changes how every page handles errors and fixes chat sending in LAN mode), then B1-B11 from the first session, then B13-B19 from the gap review, then B20-B24 from the final review wave (A-171 travels with B12). B13-B19 are independent of B1-B11 except where a batch says otherwise. Coordinate B15 and B17 with B0; see the advisories.

- **B0 Security fixes**: 34 findings, tracked in the repository's private security advisories (drafts), not here. Owner decision (2026-10-19): fix these **before** any batch below. Their details are deliberately not in this public file; read them from the advisories (repository Security tab). See the execution-time note in section 6 about where to do the work.

- **B1 Grading correctness**: [#126](https://github.com/epittman23/local-llm/issues/126) A-01, [#142](https://github.com/epittman23/local-llm/issues/142) A-17, [#140](https://github.com/epittman23/local-llm/issues/140) A-15. First: every pass rate recorded before it is suspect (A-01), and later batches measure with the grader. A-15 moves grading off the event loop; A-17 touches the same subprocess call, so the three share one PR.
- **B2 Dataset fetch and selfcheck**: [#141](https://github.com/epittman23/local-llm/issues/141) A-16. After B1: the new endpoints call the grader (selfcheck) and must use the non-blocking pattern from A-15. Owner decision: build the endpoints and Tests page actions properly (section 6).
- **B3 Fingerprint coverage**: [#127](https://github.com/epittman23/local-llm/issues/127) A-02. Owner decision: take the best fix, changing every existing id (section 6). Independent of B1/B2 in code, but do it before re-measuring anything so new runs are fingerprinted correctly.
- **B4 Compare and Report correctness**: [#129](https://github.com/epittman23/local-llm/issues/129) A-04, [#130](https://github.com/epittman23/local-llm/issues/130) A-05, [#131](https://github.com/epittman23/local-llm/issues/131) A-06, [#132](https://github.com/epittman23/local-llm/issues/132) A-07, [#128](https://github.com/epittman23/local-llm/issues/128) A-03, [#133](https://github.com/epittman23/local-llm/issues/133) A-08. A-04 and A-05 change the same response contract between the router and ComparePage, so they go together; A-06/A-07 are in the same module. A-03/A-08 are Report-only and can be a second PR in this batch.
- **B5 Tuning decisions**: [#134](https://github.com/epittman23/local-llm/issues/134) A-09, [#135](https://github.com/epittman23/local-llm/issues/135) A-10, [#136](https://github.com/epittman23/local-llm/issues/136) A-11, [#137](https://github.com/epittman23/local-llm/issues/137) A-12, [#138](https://github.com/epittman23/local-llm/issues/138) A-13, [#139](https://github.com/epittman23/local-llm/issues/139) A-14. All in tuning/tune.py; A-09 to A-12 share the ranking/cooldown code and its new test module. A-13 and A-14 are suspected: confirm first.
- **B6 Benchmarks frontend robustness**: [#143](https://github.com/epittman23/local-llm/issues/143) A-18, [#144](https://github.com/epittman23/local-llm/issues/144) A-19, [#156](https://github.com/epittman23/local-llm/issues/156) A-31. After B4, which edits ComparePage and lib/apis/benchmarks/index.ts types; A-18/A-19 edit the same API module. A-31 (backend, suspected) fits here as serving robustness.
- **B7 Chat correctness**: [#160](https://github.com/epittman23/local-llm/issues/160) A-35, [#150](https://github.com/epittman23/local-llm/issues/150) A-25, [#151](https://github.com/epittman23/local-llm/issues/151) A-26. Same hook (useChatSession.ts); independent of the benchmark batches.
- **B8 Calendar and automations**: [#158](https://github.com/epittman23/local-llm/issues/158) A-33, [#159](https://github.com/epittman23/local-llm/issues/159) A-34. Independent.
- **B9 Benchmark profile concurrency**: [#152](https://github.com/epittman23/local-llm/issues/152) A-27, [#153](https://github.com/epittman23/local-llm/issues/153) A-28. Suspected; confirm with a two-session test against Postgres. A CHECK constraint needs a new Alembic revision.
- **B10 Backend minor**: [#154](https://github.com/epittman23/local-llm/issues/154) A-29, [#155](https://github.com/epittman23/local-llm/issues/155) A-30. Suspected; independent.
- **B11 Build, CI and docs hygiene**: [#145](https://github.com/epittman23/local-llm/issues/145) A-20, [#146](https://github.com/epittman23/local-llm/issues/146) A-21, [#147](https://github.com/epittman23/local-llm/issues/147) A-22, [#148](https://github.com/epittman23/local-llm/issues/148) A-23, [#149](https://github.com/epittman23/local-llm/issues/149) A-24, [#157](https://github.com/epittman23/local-llm/issues/157) A-32. Last, or in parallel at any time: no code dependencies. A-21 changes how `make check` runs e2e, so land it before the other batches if possible to avoid surprises.

### Gap review batches (A-36 onward)

- **B12 Frontend foundations: UUIDs and API error handling** (2 issues): [#241](https://github.com/epittman23/local-llm/issues/241) A-115, [#240](https://github.com/epittman23/local-llm/issues/240) A-114. Do first after B0: `crypto.randomUUID` breaks sending in the documented LAN mode (High), and the API-helper change alters how every page sees errors, so page-level fixes in later batches should build on it. One PR per issue; the helper change touches many files, so land it before B14-B18 to avoid conflicts.
- **B13 Chat backend: streaming, persistence and provider conversion** (16 issues): [#162](https://github.com/epittman23/local-llm/issues/162) A-36, [#163](https://github.com/epittman23/local-llm/issues/163) A-37, [#164](https://github.com/epittman23/local-llm/issues/164) A-38, [#165](https://github.com/epittman23/local-llm/issues/165) A-39, [#166](https://github.com/epittman23/local-llm/issues/166) A-40, [#167](https://github.com/epittman23/local-llm/issues/167) A-41, [#168](https://github.com/epittman23/local-llm/issues/168) A-42, [#187](https://github.com/epittman23/local-llm/issues/187) A-61, [#188](https://github.com/epittman23/local-llm/issues/188) A-62, [#194](https://github.com/epittman23/local-llm/issues/194) A-68, [#290](https://github.com/epittman23/local-llm/issues/290) A-164, [#196](https://github.com/epittman23/local-llm/issues/196) A-70, [#271](https://github.com/epittman23/local-llm/issues/271) A-145, [#174](https://github.com/epittman23/local-llm/issues/174) A-48, [#172](https://github.com/epittman23/local-llm/issues/172) A-46, [#173](https://github.com/epittman23/local-llm/issues/173) A-47. The streaming and persistence code in utils/middleware.py and models/chat_messages.py; the characterization fixtures pin current behaviour, so update them deliberately in each PR. The first two issues are the day-to-day OpenRouter path: start there.
- **B14 Chat frontend** (11 issues): [#211](https://github.com/epittman23/local-llm/issues/211) A-85, [#212](https://github.com/epittman23/local-llm/issues/212) A-86, [#213](https://github.com/epittman23/local-llm/issues/213) A-87, [#214](https://github.com/epittman23/local-llm/issues/214) A-88, [#215](https://github.com/epittman23/local-llm/issues/215) A-89, [#216](https://github.com/epittman23/local-llm/issues/216) A-90, [#217](https://github.com/epittman23/local-llm/issues/217) A-91, [#218](https://github.com/epittman23/local-llm/issues/218) A-92, [#219](https://github.com/epittman23/local-llm/issues/219) A-93, [#220](https://github.com/epittman23/local-llm/issues/220) A-94, [#200](https://github.com/epittman23/local-llm/issues/200) A-74. All in useChatSession.ts / useAttachments.ts / history.ts and AdvancedParams; after B12 and alongside B7 (A-25, A-26, A-35), which touch the same hook: merge B7 first or fold its issues into this batch.
- **B15 Calendar, reminders and automations** (11 issues): [#171](https://github.com/epittman23/local-llm/issues/171) A-45, [#176](https://github.com/epittman23/local-llm/issues/176) A-50, [#183](https://github.com/epittman23/local-llm/issues/183) A-57, [#184](https://github.com/epittman23/local-llm/issues/184) A-58, [#268](https://github.com/epittman23/local-llm/issues/268) A-142, [#182](https://github.com/epittman23/local-llm/issues/182) A-56, [#264](https://github.com/epittman23/local-llm/issues/264) A-138, [#265](https://github.com/epittman23/local-llm/issues/265) A-139, [#266](https://github.com/epittman23/local-llm/issues/266) A-140, [#267](https://github.com/epittman23/local-llm/issues/267) A-141, [#270](https://github.com/epittman23/local-llm/issues/270) A-144. Shares utils/calendar.py, utils/automations.py and models/calendar.py with B8 (A-33, A-34); do after B8 or merge them. Reminder fixes need the calendar:alert handler to be visible in the app.
- **B16 Knowledge, retrieval and files** (17 issues): [#195](https://github.com/epittman23/local-llm/issues/195) A-69, [#197](https://github.com/epittman23/local-llm/issues/197) A-71, [#177](https://github.com/epittman23/local-llm/issues/177) A-51, [#179](https://github.com/epittman23/local-llm/issues/179) A-53, [#180](https://github.com/epittman23/local-llm/issues/180) A-54, [#178](https://github.com/epittman23/local-llm/issues/178) A-52, [#186](https://github.com/epittman23/local-llm/issues/186) A-60, [#276](https://github.com/epittman23/local-llm/issues/276) A-150, [#229](https://github.com/epittman23/local-llm/issues/229) A-103, [#230](https://github.com/epittman23/local-llm/issues/230) A-104, [#231](https://github.com/epittman23/local-llm/issues/231) A-105, [#232](https://github.com/epittman23/local-llm/issues/232) A-106, [#233](https://github.com/epittman23/local-llm/issues/233) A-107, [#234](https://github.com/epittman23/local-llm/issues/234) A-108, [#235](https://github.com/epittman23/local-llm/issues/235) A-109, [#238](https://github.com/epittman23/local-llm/issues/238) A-112, [#258](https://github.com/epittman23/local-llm/issues/258) A-132. Retrieval correctness first (directory delete, chat-file ranking), then the admin Documents settings, which share documents.ts.
- **B17 Tool servers, MCP, OAuth and plugins** (17 issues): [#189](https://github.com/epittman23/local-llm/issues/189) A-63, [#190](https://github.com/epittman23/local-llm/issues/190) A-64, [#191](https://github.com/epittman23/local-llm/issues/191) A-65, [#192](https://github.com/epittman23/local-llm/issues/192) A-66, [#175](https://github.com/epittman23/local-llm/issues/175) A-49, [#169](https://github.com/epittman23/local-llm/issues/169) A-43, [#273](https://github.com/epittman23/local-llm/issues/273) A-147, [#274](https://github.com/epittman23/local-llm/issues/274) A-148, [#275](https://github.com/epittman23/local-llm/issues/275) A-149, [#284](https://github.com/epittman23/local-llm/issues/284) A-158, [#285](https://github.com/epittman23/local-llm/issues/285) A-159, [#286](https://github.com/epittman23/local-llm/issues/286) A-160, [#287](https://github.com/epittman23/local-llm/issues/287) A-161, [#288](https://github.com/epittman23/local-llm/issues/288) A-162, [#269](https://github.com/epittman23/local-llm/issues/269) A-143, [#193](https://github.com/epittman23/local-llm/issues/193) A-67, [#272](https://github.com/epittman23/local-llm/issues/272) A-146. utils/tools.py and utils/oauth.py; after B0 (coordinate with B0; see the advisories).
- **B18 Workspace and admin pages** (41 issues): [#221](https://github.com/epittman23/local-llm/issues/221) A-95, [#222](https://github.com/epittman23/local-llm/issues/222) A-96, [#223](https://github.com/epittman23/local-llm/issues/223) A-97, [#224](https://github.com/epittman23/local-llm/issues/224) A-98, [#225](https://github.com/epittman23/local-llm/issues/225) A-99, [#226](https://github.com/epittman23/local-llm/issues/226) A-100, [#227](https://github.com/epittman23/local-llm/issues/227) A-101, [#228](https://github.com/epittman23/local-llm/issues/228) A-102, [#203](https://github.com/epittman23/local-llm/issues/203) A-77, [#204](https://github.com/epittman23/local-llm/issues/204) A-78, [#278](https://github.com/epittman23/local-llm/issues/278) A-152, [#205](https://github.com/epittman23/local-llm/issues/205) A-79, [#198](https://github.com/epittman23/local-llm/issues/198) A-72, [#199](https://github.com/epittman23/local-llm/issues/199) A-73, [#242](https://github.com/epittman23/local-llm/issues/242) A-116, [#243](https://github.com/epittman23/local-llm/issues/243) A-117, [#244](https://github.com/epittman23/local-llm/issues/244) A-118, [#245](https://github.com/epittman23/local-llm/issues/245) A-119, [#246](https://github.com/epittman23/local-llm/issues/246) A-120, [#247](https://github.com/epittman23/local-llm/issues/247) A-121, [#248](https://github.com/epittman23/local-llm/issues/248) A-122, [#249](https://github.com/epittman23/local-llm/issues/249) A-123, [#250](https://github.com/epittman23/local-llm/issues/250) A-124, [#251](https://github.com/epittman23/local-llm/issues/251) A-125, [#236](https://github.com/epittman23/local-llm/issues/236) A-110, [#237](https://github.com/epittman23/local-llm/issues/237) A-111, [#239](https://github.com/epittman23/local-llm/issues/239) A-113, [#201](https://github.com/epittman23/local-llm/issues/201) A-75, [#202](https://github.com/epittman23/local-llm/issues/202) A-76, [#209](https://github.com/epittman23/local-llm/issues/209) A-83, [#210](https://github.com/epittman23/local-llm/issues/210) A-84, [#206](https://github.com/epittman23/local-llm/issues/206) A-80, [#207](https://github.com/epittman23/local-llm/issues/207) A-81, [#208](https://github.com/epittman23/local-llm/issues/208) A-82, [#259](https://github.com/epittman23/local-llm/issues/259) A-133, [#260](https://github.com/epittman23/local-llm/issues/260) A-134, [#261](https://github.com/epittman23/local-llm/issues/261) A-135, [#262](https://github.com/epittman23/local-llm/issues/262) A-136, [#263](https://github.com/epittman23/local-llm/issues/263) A-137, [#280](https://github.com/epittman23/local-llm/issues/280) A-154, [#279](https://github.com/epittman23/local-llm/issues/279) A-153. Independent page-level fixes; after B12. JWT expiry (High) and the prompt production bug (High) first. The interface-permission scope question needs the owner (see section 6).
- **B19 Channels, notifications and chat data** (19 issues): [#252](https://github.com/epittman23/local-llm/issues/252) A-126, [#253](https://github.com/epittman23/local-llm/issues/253) A-127, [#254](https://github.com/epittman23/local-llm/issues/254) A-128, [#255](https://github.com/epittman23/local-llm/issues/255) A-129, [#256](https://github.com/epittman23/local-llm/issues/256) A-130, [#257](https://github.com/epittman23/local-llm/issues/257) A-131, [#277](https://github.com/epittman23/local-llm/issues/277) A-151, [#185](https://github.com/epittman23/local-llm/issues/185) A-59, [#170](https://github.com/epittman23/local-llm/issues/170) A-44, [#289](https://github.com/epittman23/local-llm/issues/289) A-163, [#291](https://github.com/epittman23/local-llm/issues/291) A-165, [#292](https://github.com/epittman23/local-llm/issues/292) A-166, [#293](https://github.com/epittman23/local-llm/issues/293) A-167, [#294](https://github.com/epittman23/local-llm/issues/294) A-168, [#295](https://github.com/epittman23/local-llm/issues/295) A-169, [#283](https://github.com/epittman23/local-llm/issues/283) A-157, [#282](https://github.com/epittman23/local-llm/issues/282) A-156, [#181](https://github.com/epittman23/local-llm/issues/181) A-55, [#281](https://github.com/epittman23/local-llm/issues/281) A-155. Channel fixes after B12 (they depend on helpers throwing); the chat-data fixes are independent model-layer changes.

### Final review wave batches (A-170 onward)

- **B20 Run modes, startup, shutdown and the chat backend (final wave)** (11 issues): [#297](https://github.com/epittman23/local-llm/issues/297) A-171, [#298](https://github.com/epittman23/local-llm/issues/298) A-172, [#299](https://github.com/epittman23/local-llm/issues/299) A-173, [#300](https://github.com/epittman23/local-llm/issues/300) A-174, [#301](https://github.com/epittman23/local-llm/issues/301) A-175, [#359](https://github.com/epittman23/local-llm/issues/359) A-233, [#360](https://github.com/epittman23/local-llm/issues/360) A-234, [#361](https://github.com/epittman23/local-llm/issues/361) A-235, [#362](https://github.com/epittman23/local-llm/issues/362) A-236, [#363](https://github.com/epittman23/local-llm/issues/363) A-237, [#364](https://github.com/epittman23/local-llm/issues/364) A-238. Land A-171 together with B12: both are needed before LAN mode can chat. A-233/A-234 touch `_fan_out_chat` next to B13's streaming fixes; A-236 complements B13's connection-drop fix.
- **B21 Knowledge files and folders (final wave)** (11 issues): [#307](https://github.com/epittman23/local-llm/issues/307) A-181, [#308](https://github.com/epittman23/local-llm/issues/308) A-182, [#309](https://github.com/epittman23/local-llm/issues/309) A-183, [#310](https://github.com/epittman23/local-llm/issues/310) A-184, [#311](https://github.com/epittman23/local-llm/issues/311) A-185, [#312](https://github.com/epittman23/local-llm/issues/312) A-186, [#313](https://github.com/epittman23/local-llm/issues/313) A-187, [#314](https://github.com/epittman23/local-llm/issues/314) A-188, [#315](https://github.com/epittman23/local-llm/issues/315) A-189, [#316](https://github.com/epittman23/local-llm/issues/316) A-190, [#317](https://github.com/epittman23/local-llm/issues/317) A-191. Routers for knowledge files, uploads and folders; A-181 (High) first. Shares `process_file` with B22 and B16: coordinate.
- **B22 Retrieval engine and memories (final wave)** (13 issues): [#346](https://github.com/epittman23/local-llm/issues/346) A-220, [#347](https://github.com/epittman23/local-llm/issues/347) A-221, [#348](https://github.com/epittman23/local-llm/issues/348) A-222, [#349](https://github.com/epittman23/local-llm/issues/349) A-223, [#350](https://github.com/epittman23/local-llm/issues/350) A-224, [#351](https://github.com/epittman23/local-llm/issues/351) A-225, [#352](https://github.com/epittman23/local-llm/issues/352) A-226, [#353](https://github.com/epittman23/local-llm/issues/353) A-227, [#354](https://github.com/epittman23/local-llm/issues/354) A-228, [#355](https://github.com/epittman23/local-llm/issues/355) A-229, [#357](https://github.com/epittman23/local-llm/issues/357) A-231, [#358](https://github.com/epittman23/local-llm/issues/358) A-232, [#303](https://github.com/epittman23/local-llm/issues/303) A-177. pgvector, rerankers, external retrieval and memory vectors; after B16 (same retrieval files).
- **B23 Calendar, automations, channels and notes (final wave)** (17 issues): [#318](https://github.com/epittman23/local-llm/issues/318) A-192, [#319](https://github.com/epittman23/local-llm/issues/319) A-193, [#320](https://github.com/epittman23/local-llm/issues/320) A-194, [#321](https://github.com/epittman23/local-llm/issues/321) A-195, [#322](https://github.com/epittman23/local-llm/issues/322) A-196, [#323](https://github.com/epittman23/local-llm/issues/323) A-197, [#324](https://github.com/epittman23/local-llm/issues/324) A-198, [#325](https://github.com/epittman23/local-llm/issues/325) A-199, [#326](https://github.com/epittman23/local-llm/issues/326) A-200, [#327](https://github.com/epittman23/local-llm/issues/327) A-201, [#328](https://github.com/epittman23/local-llm/issues/328) A-202, [#329](https://github.com/epittman23/local-llm/issues/329) A-203, [#330](https://github.com/epittman23/local-llm/issues/330) A-204, [#331](https://github.com/epittman23/local-llm/issues/331) A-205, [#332](https://github.com/epittman23/local-llm/issues/332) A-206, [#333](https://github.com/epittman23/local-llm/issues/333) A-207, [#356](https://github.com/epittman23/local-llm/issues/356) A-230. A-192 and A-201 (High) first. Calendar items share calendarModel.ts with B8 and B15; do after them.
- **B24 Sharing, workspace, admin integrations and plugins (final wave)** (17 issues): [#334](https://github.com/epittman23/local-llm/issues/334) A-208, [#335](https://github.com/epittman23/local-llm/issues/335) A-209, [#336](https://github.com/epittman23/local-llm/issues/336) A-210, [#337](https://github.com/epittman23/local-llm/issues/337) A-211, [#338](https://github.com/epittman23/local-llm/issues/338) A-212, [#339](https://github.com/epittman23/local-llm/issues/339) A-213, [#340](https://github.com/epittman23/local-llm/issues/340) A-214, [#341](https://github.com/epittman23/local-llm/issues/341) A-215, [#342](https://github.com/epittman23/local-llm/issues/342) A-216, [#343](https://github.com/epittman23/local-llm/issues/343) A-217, [#344](https://github.com/epittman23/local-llm/issues/344) A-218, [#345](https://github.com/epittman23/local-llm/issues/345) A-219, [#296](https://github.com/epittman23/local-llm/issues/296) A-170, [#302](https://github.com/epittman23/local-llm/issues/302) A-176, [#304](https://github.com/epittman23/local-llm/issues/304) A-178, [#305](https://github.com/epittman23/local-llm/issues/305) A-179, [#306](https://github.com/epittman23/local-llm/issues/306) A-180. Coordinate A-208 with B0 (see the advisories). A-214 (High) first among the Ollama items.

## 4. Per-bug detail

### B1 Grading correctness

#### A-01 [#126](https://github.com/epittman23/local-llm/issues/126): Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin

- Severity / status / effort: Critical / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:140-160`; `apps/server/local_llm/benchmarks/evaluation/grading/mbpp.py:15-25`; `apps/server/local_llm/benchmarks/evaluation/grading/humaneval.py:25-32`
- Root cause: Outcome inferred from exit status alone; the model's code runs as `__main__` with an inherited stdin.
- Recommended fix: Have the harness print a random per-run sentinel after the tests and require it in stdout for PASS; run the model code under a non-`__main__` module name (or strip/neutralise its main block); pass `stdin=subprocess.DEVNULL`. Do not re-grade stored answers (owner decision, section 6).
- Files likely to change: grading/__init__.py, grading/mbpp.py, grading/humaneval.py, grading/ds1000.py, tests/test_grading*.py
- Regression risks: DS-1000 harness structure differs; sentinel must not be forgeable by printing it from model code (use a nonce generated per run). Calibration results may shift.
- Docs to update: docs/guides/benchmarks.md (grading section); docs/decisions.md entry recording the changed meaning of PASS (any results recorded before the fix are not comparable; the database held none on 2026-10-19).
- Acceptance criteria: New pytest cases: a wrong answer with `unittest.main()`/`sys.exit(0)` grades as fail; a correct answer with an `input()` main block grades as pass; existing grading tests stay green.

#### A-17 [#142](https://github.com/epittman23/local-llm/issues/142): Grading timeouts kill only the direct child; processes spawned by model code survive

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:146-150`
- Root cause: No process group.
- Recommended fix: `start_new_session=True` and kill the process group on timeout.
- Files likely to change: grading/__init__.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: a forked sleeper is gone after the timeout.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-15 [#140](https://github.com/epittman23/local-llm/issues/140): Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/runner.py:352`; `apps/server/local_llm/benchmarks/evaluation/runner.py:492-545`; `apps/server/local_llm/routers/benchmarks/tests.py:55-100`
- Root cause: Synchronous I/O in coroutines.
- Recommended fix: `await asyncio.to_thread(...)` around grading and preparation, or asyncio subprocesses.
- Files likely to change: evaluation/runner.py, tests
- Regression risks: Thread safety of anything grade() touches (it is self-contained per temp dir).
- Docs to update: None.
- Acceptance criteria: Async test: a ticker keeps running (max gap well under 1 s) during a slow grade.

### B2 Dataset fetch and selfcheck

#### A-16 [#141](https://github.com/epittman23/local-llm/issues/141): No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/datasets.py:90-95`; `apps/server/local_llm/benchmarks/evaluation/datasets.py:229`; `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:273-320`; `apps/server/local_llm/routers/benchmarks/tests.py:1-120`; `docs/guides/benchmarks.md:128-137`; `docs/guides/benchmarks.md:336`
- Root cause: Functionality lost in the CLI-to-app migration; docs not updated.
- Recommended fix: Build admin endpoints (`get_admin_user`) and Tests page actions for dataset fetch (with a force-refetch option), selfcheck (grade the references and write the calibration) and single-item run, as docs/guides/benchmarks.md already describes them. Owner decision: these are approved interface additions (section 6). Run downloads and grading off the event loop (A-15's pattern) and stream progress the way the existing run endpoint does. Make the refetch atomic (write items and manifest to a temp directory, then rename), see NOTES.md.
- Files likely to change: routers/benchmarks/tests.py, routes/benchmarks/TestsPage.tsx, lib/apis/benchmarks/index.ts, tests
- Regression risks: Long-running downloads need the same non-blocking treatment as A-15.
- Docs to update: docs/guides/benchmarks.md; README "Pages and URLs" if UI changes; docs/decisions.md.
- Acceptance criteria: Router tests for each new endpoint (admin required, success, error); a Vitest/Playwright test for each Tests page action; `datasets.py`'s "not downloaded yet" message names the Tests page action instead of `datasets.fetch_one`.

### B3 Fingerprint coverage

#### A-02 [#127](https://github.com/epittman23/local-llm/issues/127): config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration

- Severity / status / effort: Critical / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/serving/fingerprint.py:76-111`; `apps/server/local_llm/benchmarks/serving/launcher.py:107`; `apps/server/local_llm/benchmarks/serving/launcher.py:146`; `apps/server/local_llm/benchmarks/serving/profiles.py:329`; `apps/server/local_llm/benchmarks/serving/profiles.py:344`
- Root cause: `extra` is a free-form profile field (only `--parallel` and reasoning flags are rejected) with no fingerprint line; the model is identified by alias only, so a new profile version with a different `model_path` and the same alias collides.
- Recommended fix (owner decision, section 6: no data exists, take the best fix): add two fingerprint lines, always present, so every id changes once: `model: <basename of the resolved model file>` and `extra: <args joined with spaces, or n/a>`. Use the **basename**, not the path: results are grouped by the server's alias (`env_profile.served_model` reads `/v1/models`), so two quants under one alias are merged today, while relocating the weights directory must not change the id. Update `stats.parse_config_text` and `compare.flags_of` so the new lines parse and count in the multi-flag warning.
- Serving baseline: `docs/serving-baseline/` is the record of what the shell produced, so do not rewrite its captured ids. Keep the shell-parity test for the six-line form (for example by testing the six lines and the legacy hash separately), add new expected cases for the eight-line form, and replace the `model-path-not-fingerprinted` invariant with `model-directory-not-fingerprinted` (same basename, different directory, same id). Explain the change in its README.
- Files likely to change: serving/fingerprint.py, analysis/stats.py, docs/serving-baseline/*, tests/test_fingerprint*.py, a new migration
- Regression risks: every config_id changes (accepted: the database held no benchmark data on 2026-10-19); the baseline fingerprint test pins the six-line ids and must keep passing for them.
- Docs to update: fingerprint.py docstring; docs/guides/llama-cpp.md; docs/guides/telemetry.md; docs/serving-baseline/README.md; docs/decisions.md (dated entry) and the matching roadmap milestone; a `benchmark_schema_note` row in a new Alembic revision (AGENTS.md requires it even with no data).
- Acceptance criteria: new tests: different `extra` gives a different id; a different model basename gives a different id; the same basename in another directory gives the same id; the legacy six-line cases in `fingerprints.json` still hash to their captured ids; `parse_config_text` round-trips the new lines.

### B4 Compare and Report correctness

#### A-04 [#129](https://github.com/epittman23/local-llm/issues/129): Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/routers/benchmarks/compare.py:27-30`; `apps/server/local_llm/benchmarks/analysis/compare.py:654`; `apps/server/local_llm/benchmarks/analysis/compare.py:727`; `apps/web/src/routes/benchmarks/ComparePage.tsx:42`; `apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`
- Root cause: Misnamed tuple unpack in the router; Playwright mocks the shape the page expects and no backend test checks the response keys.
- Recommended fix: Return `{rows, derived, notes}` (plus explicit column lists if wanted); render the rows table with columns from the first row's keys, and the derived table beside it; update the e2e mock to the real shape.
- Files likely to change: routers/benchmarks/compare.py, routes/benchmarks/ComparePage.tsx, lib/apis/benchmarks/index.ts types, e2e/benchmarks.spec.ts, a backend router test
- Regression risks: Response key rename is a contract change between the two apps; change both in one PR.
- Docs to update: docs/guides/benchmarks.md (Compare, by serving).
- Acceptance criteria: A backend test asserts the serving response keys and that rows carry gen_tps; an e2e test with the real shape renders both tables.

#### A-05 [#130](https://github.com/epittman23/local-llm/issues/130): Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:416-438`; `apps/server/local_llm/routers/benchmarks/compare.py:37-39`; `apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`
- Root cause: Backend pivot shape and the generic table normaliser were never reconciled; mocks hide it.
- Recommended fix: Flatten in the backend (`row[name] = pass_rate`, identity columns first) or map `per_benchmark` in the page; add tests on both sides.
- Files likely to change: analysis/compare.py or ComparePage.tsx, tests
- Regression risks: Same contract caveat as A-04; batch them together.
- Docs to update: docs/guides/benchmarks.md Compare section if it describes the view.
- Acceptance criteria: Test renders a pass-rate cell per benchmark plus model/config/tier for a mocked real-shape response.

#### A-06 [#131](https://github.com/epittman23/local-llm/issues/131): Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:108-120`; `apps/server/local_llm/benchmarks/serving/fingerprint.py:89-92`
- Root cause: Wrong source string for the regex; `stats.parse_config_text` already reads `fa` correctly.
- Recommended fix: Read `config_value(lines, 'fa')` directly (as stats does), or regex over the whole cache line.
- Files likely to change: analysis/compare.py, new tests/test_compare.py
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: configs differing only in fa produce `differing == ['fa']`.

#### A-07 [#132](https://github.com/epittman23/local-llm/issues/132): Compare ranks rows across tiers together and binds the baseline delta to the first matching group only

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:358-380`
- Root cause: No per-tier partitioning; baseline chosen once instead of per tier (and per system/adapter).
- Recommended fix: Sort within each tier; choose the baseline group per tier, matched on system and adapter.
- Files likely to change: analysis/compare.py, tests
- Regression risks: Changes row order the UI shows; update e2e expectations if any.
- Docs to update: None if the code is brought in line with benchmarks.md.
- Acceptance criteria: Unit test: with baseline A, `B full` gets a delta against `A full`, and rows are grouped by tier.

#### A-03 [#128](https://github.com/epittman23/local-llm/issues/128): Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show

- Severity / status / effort: Critical / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/report.py:1895-1925`; `apps/server/local_llm/benchmarks/analysis/report.py:1500-1510`
- Root cause: Text written for one historical null result and hardcoded.
- Recommended fix: Derive headline wording from `p_perm`/Holm-adjusted p-values and from max |Δ pass rate| compared to the floor; state which family/block it summarises; same for the floor sentence.
- Files likely to change: analysis/report.py, new tests/test_report_headline.py
- Regression risks: None beyond wording; check other hardcoded verdict sentences in report.py.
- Docs to update: docs/guides/benchmarks.md Report section if it quotes the headline.
- Acceptance criteria: Unit test: significant data yields a headline stating a difference; null data keeps the current wording; the floor sentence appears only when every difference is below the floor.

#### A-08 [#133](https://github.com/epittman23/local-llm/issues/133): Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/analysis/report.py:1413`; `apps/server/local_llm/benchmarks/analysis/report.py:1445`; `apps/server/local_llm/benchmarks/analysis/report.py:1462`; `apps/server/local_llm/benchmarks/analysis/report.py:1490`
- Root cause: Pooled n and nominal alpha used for a per-block, multiplicity-corrected test.
- Recommended fix: Use per-block n (or label the figure as a hypothetical pooled test) and alpha/(k-1) (or the Holm worst case).
- Files likely to change: analysis/report.py, tests
- Regression risks: Low.
- Docs to update: docs/guides/benchmarks.md if it explains the power section.
- Acceptance criteria: Unit test pins MDE for a two-block design to the per-block n and corrected alpha.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B5 Tuning decisions

#### A-09 [#134](https://github.com/epittman23/local-llm/issues/134): Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1282-1285`; `apps/server/local_llm/benchmarks/tuning/tune.py:1328-1335`; `apps/server/local_llm/benchmarks/tuning/tune.py:1405-1449`
- Root cause: The "beat the baseline" condition is never checked.
- Recommended fix: Require score > 0 in `best()` and in `finish()`'s ranked list (optionally a significance test against baseline); make `refine()` stop when none qualifies.
- Files likely to change: tuning/tune.py, new tests/test_tune_ranking.py
- Regression risks: Past sweep verdicts in the DB may be wrong; consider a decisions.md note.
- Docs to update: docs/guides/benchmarks.md / llama-cpp.md tuning verdicts if they describe the rule.
- Acceptance criteria: Unit test: with all candidates slower than baseline, `best()` is None and the verdict is rejected.

#### A-10 [#135](https://github.com/epittman23/local-llm/issues/135): Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1175-1179`
- Root cause: Falsy-zero bug; only None should map to -inf (tune.py near 1563 already does this correctly).
- Recommended fix: Use an explicit `is not None` check in the key.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: a 0.0-scored candidate survives over a negative one.

#### A-11 [#136](https://github.com/epittman23/local-llm/issues/136): Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1194-1206`
- Root cause: Positional pairing instead of keyed pairing; no minimum-n rule.
- Recommended fix: Compute differences over item keys present for all three cells; treat n below a threshold as uncertain.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test with misaligned missing items reproduces the aligned p-value.

#### A-12 [#137](https://github.com/epittman23/local-llm/issues/137): Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:515-529`
- Root cause: Assignment instead of a pause-local variable.
- Recommended fix: Keep a local `elapsed`, check `self.total_seconds + elapsed` in `budget_exhausted`, add once.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test with a fake clock: totals accumulate across pauses and the cap trips.

#### A-13 [#138](https://github.com/epittman23/local-llm/issues/138): Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever

- Severity / status / effort: Medium / Suspected / M
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:942-950`; `apps/server/local_llm/benchmarks/tuning/tune.py:255-265`; `apps/server/local_llm/benchmarks/tuning/tune_probe.py:195-222`; `apps/server/local_llm/routers/benchmarks/tune.py:112-120`
- Root cause: Cleanup is cancellable and nothing closes open visits/pauses on interruption.
- Recommended fix: Shield teardown (`asyncio.shield`) or run it in an uncancellable finally; close open visits and pauses in `finish()` when interrupted.
- Files likely to change: tuning/tune.py, tuning/tune_probe.py, tests
- Regression risks: Shielded teardown must still respect a hard timeout.
- Docs to update: None.
- Acceptance criteria: Async test cancelling during teardown shows ServeProcess.stop called and rows closed.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-14 [#139](https://github.com/epittman23/local-llm/issues/139): A sweep whose baseline fails to load never narrows and does not say why

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1112`; `apps/server/local_llm/benchmarks/tuning/tune.py:1193`
- Root cause: No handling for an infeasible baseline.
- Recommended fix: End the sweep with an explicit reason when the baseline is infeasible.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: infeasible baseline ends the sweep with that reason.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B6 Benchmarks frontend robustness

#### A-18 [#143](https://github.com/epittman23/local-llm/issues/143): Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/apis/benchmarks/index.ts:131-185`; `apps/web/src/lib/apis/benchmarks/index.ts:720-790`; `apps/web/src/routes/benchmarks/ServePage.tsx:171`; `apps/web/src/routes/benchmarks/ServePage.tsx:181`; `apps/web/src/routes/benchmarks/TunePage.tsx:146-180`; `apps/web/src/routes/benchmarks/TunePage.tsx:229`; `apps/web/src/routes/benchmarks/TunePage.tsx:467`; `apps/web/src/routes/benchmarks/TunePage.tsx:526`
- Root cause: Inconsistent error contract between `lib/apis/benchmarks/index.ts` and its callers.
- Recommended fix: Normalise errors in the helpers with the existing `errorMessage()` from profiles.ts and rethrow on network failure; render `String(err)` in the pages.
- Files likely to change: lib/apis/benchmarks/index.ts, ServePage.tsx, TunePage.tsx, unit tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest: a 422 and a 409 produce readable messages; a rejected fetch rejects the helper.

#### A-19 [#144](https://github.com/epittman23/local-llm/issues/144): Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune)

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/benchmarks/TunePage.tsx:132-194`; `apps/web/src/lib/apis/benchmarks/index.ts:910-939`
- Root cause: The 2026-09-27 L17 fix covered ServePage and TestsPage only.
- Recommended fix: Pass a caller-owned controller into `streamTuneLog` (as `streamServe` does) and apply the ServePage pattern.
- Files likely to change: TunePage.tsx, lib/apis/benchmarks/index.ts, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest or e2e: switching sweeps mid-request leaves exactly one active stream.

#### A-31 [#156](https://github.com/epittman23/local-llm/issues/156): Telemetry recorder attaches a new run to whatever server already answers on the port

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:109-117`; `apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:403-412`
- Root cause: Readiness check does not verify the server it measures is the one just spawned.
- Recommended fix: Check the spawned pid is alive and/or that `/v1/models` reports the expected alias before opening the run; refuse to start when the port is already bound.
- Files likely to change: serving/telemetry_recorder.py, serving/launcher.py, tests
- Regression risks: Low.
- Docs to update: docs/guides/telemetry.md.
- Acceptance criteria: Test with a stub listener already on the port: start fails or no run is opened.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B7 Chat correctness

#### A-35 [#160](https://github.com/epittman23/local-llm/issues/160): Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/lib/chat/request.ts:142-147`; `apps/web/src/lib/chat/request.ts:181`; `apps/web/src/routes/chat/useChatSession.ts:352`; `apps/web/src/routes/chat/useChatSession.ts:406`; `apps/web/src/routes/chat/useChatSession.ts:499`
- Root cause: The pruning step was lost in the port (an undocumented behaviour change).
- Recommended fix: Before `turnFiles`, filter `chatFiles` by id to files of `messagesList(history, responseId)`, and write the filtered list back with `setChatFiles`, as the original did.
- Files likely to change: lib/chat/request.ts, routes/chat/useChatSession.ts, request.test.ts
- Regression risks: Files attached through other paths (e.g. knowledge/collections in chatFiles) must still be kept if the original kept them; compare carefully.
- Docs to update: None.
- Acceptance criteria: Vitest: a history whose path carries no files produces no `files` in the body; a path carrying X still sends X.

#### A-25 [#150](https://github.com/epittman23/local-llm/issues/150): A reply left unfinished on a non-current branch stays "generating" forever after reload

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/lib/chat/history.ts:220-232`; `apps/web/src/routes/chat/useChatSession.ts:166-190`
- Root cause: Condition contradicts the function's own docstring ("mark every assistant reply but the current one done").
- Recommended fix: When no tasks are pending, mark every `done: false` assistant reply done in `loadChat` (or in `normalizeHistory` given a no-live-tasks flag).
- Files likely to change: lib/chat/history.ts, routes/chat/useChatSession.ts, their unit tests
- Regression risks: Do not finalise a reply whose task is still live.
- Docs to update: None.
- Acceptance criteria: Vitest: loading a history with a stale non-current `done:false` reply and no pending tasks leaves nothing generating.

#### A-26 [#151](https://github.com/epittman23/local-llm/issues/151): Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:455-470`; `apps/server/local_llm/main.py:1714`
- Root cause: The 2026-09-27 L3 fix covered only chats without an id.
- Recommended fix: Track an in-flight ref; when no task ids are known yet, set `stopPendingRef` regardless of chat id and stop the ids when the POST resolves; apply the same in `continueReply`.
- Files likely to change: routes/chat/useChatSession.ts, useChatSession.test.tsx
- Regression risks: Must not double-stop.
- Docs to update: None.
- Acceptance criteria: Vitest with a delayed POST: Stop before resolution results in a stop call for the returned task ids.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B8 Calendar and automations

#### A-33 [#158](https://github.com/epittman23/local-llm/issues/158): Editing a calendar event cannot remove its repeat rule, description or location

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/calendar/calendarModel.ts:196-207`; `apps/web/src/lib/apis/calendar/index.ts:319-334`; `apps/server/local_llm/models/calendar.py:703-716`
- Root cause: "Unset" and "cleared" are both encoded as an absent key.
- Recommended fix: When editing, send explicit `null` for cleared fields (the backend form already accepts `None` for rrule; verify description/location); keep omitting an rrule the form cannot express so it is preserved.
- Files likely to change: routes/calendar/calendarModel.ts, its unit test; possibly the backend form
- Regression risks: Must not clear rrules the picker cannot represent.
- Docs to update: None.
- Acceptance criteria: Vitest: editing an event with repeat set to none produces a payload with `rrule: null`; an e2e or backend test shows the rule removed.

#### A-34 [#159](https://github.com/epittman23/local-llm/issues/159): Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/automations/automationModel.ts:64-75`; `apps/web/src/routes/automations/automationModel.ts:86-99`; `apps/web/src/routes/automations/automationModel.ts:122-138`
- Root cause: Representability is decided from FREQ alone.
- Recommended fix: Return CUSTOM (keeping the text verbatim) when any key/value is outside what the picker expresses, for example by requiring `buildRrule(parseRrule(r))` to equal the normalised input; use the same test in `formatSchedule`.
- Files likely to change: routes/automations/automationModel.ts, its unit test
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest: the three rules above round-trip unchanged and are labelled as custom.

### B9 Benchmark profile concurrency

#### A-27 [#152](https://github.com/epittman23/local-llm/issues/152): Concurrent archive and set-default can leave the default serving profile archived

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/benchmarks/profiles.py:341-368`; `apps/server/local_llm/routers/benchmarks/profiles.py:257-274`
- Root cause: Check-then-write under READ COMMITTED; no constraint.
- Recommended fix: `SELECT ... FOR UPDATE` in both methods, or a CHECK constraint in a new revision.
- Files likely to change: models/benchmarks/profiles.py, maybe a migration, tests
- Regression risks: A new constraint must handle existing rows.
- Docs to update: None.
- Acceptance criteria: Concurrency test (two sessions) cannot produce an archived default.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-28 [#153](https://github.com/epittman23/local-llm/issues/153): Concurrent profile create/clone/version edit returns 500 instead of 409

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/benchmarks/profiles.py:298-330`; `apps/server/local_llm/routers/benchmarks/profiles.py:167-222`
- Root cause: IntegrityError not mapped.
- Recommended fix: Catch IntegrityError, roll back, raise 409.
- Files likely to change: models/benchmarks/profiles.py or routers/benchmarks/profiles.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: a duplicate insert returns 409.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B10 Backend minor

#### A-29 [#154](https://github.com/epittman23/local-llm/issues/154): Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/routers/chats.py:250-262`; `apps/server/local_llm/routers/chats.py:306-315`; `apps/server/local_llm/routers/chats.py:440-453`; `apps/server/local_llm/models/chats.py:1409`; `apps/server/local_llm/models/chats.py:1486`
- Root cause: No `ge=1` validation (inherited).
- Recommended fix: Declare `page` with `Query(ge=1)` on these routes.
- Files likely to change: routers/chats.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: page=0 returns 422.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-30 [#155](https://github.com/epittman23/local-llm/issues/155): Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/utils/middleware.py:4977`; `apps/server/local_llm/utils/middleware.py:5021`; `apps/server/local_llm/utils/response.py:100-141`
- Root cause: Per-chunk merge instead of last-wins per pass.
- Recommended fix: Keep a per-pass usage that each chunk overwrites; merge it once per pass.
- Files likely to change: utils/middleware.py, tests
- Regression risks: Characterization fixtures pin current behaviour; update deliberately.
- Docs to update: None.
- Acceptance criteria: Characterization test with repeated cumulative usage records it once.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B11 Build, CI and docs hygiene

#### A-20 [#145](https://github.com/epittman23/local-llm/issues/145): make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap

- Severity / status / effort: Medium / Confirmed / S
- Locations: `Makefile:118-124`
- Root cause: `&&` and `;` mixed under `-e`.
- Recommended fix: Separate the steps with `;` (so `-e` aborts) and set the trap before starting the daemon.
- Files likely to change: Makefile
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: With `bun install` forced to fail, `make frontend` exits non-zero and no astro daemon is left (`bunx astro dev status`).

#### A-21 [#146](https://github.com/epittman23/local-llm/issues/146): make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI

- Severity / status / effort: Low / Confirmed / S
- Locations: `Makefile:175-182`; `.github/workflows/ci.yml:108-109`; `apps/web/playwright.config.ts:1-30`; `docs/guides/testing.md:17-24`; `docs/guides/testing.md:52-56`
- Root cause: Worker count pinned in the Makefile only; behaviour switched by the CI env var.
- Recommended fix (owner decision: use `CI=1`): pin `workers: 2` in playwright.config.ts and run the Make target as `CI=1 bun run test:e2e`, so retries, `forbidOnly` and server reuse match CI. Note in the Makefile comment and testing.md that `CI=1` disables dev-server reuse, so a running `make frontend` must be stopped first (it already must be).
- Files likely to change: Makefile, playwright.config.ts, docs
- Regression risks: CI=1 locally disables dev-server reuse.
- Docs to update: docs/guides/testing.md, Makefile comment, AGENTS.md Commands.
- Acceptance criteria: Make and CI invoke the same command; a `test.only` fails `make test-e2e`.

#### A-22 [#147](https://github.com/epittman23/local-llm/issues/147): make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up

- Severity / status / effort: Low / Suspected / S
- Locations: `Makefile:145-166`
- Root cause: Probe over the wrong transport; no timeout exit.
- Recommended fix: Probe with `pg_isready -h 127.0.0.1` and exit with a message when the loop runs out.
- Files likely to change: Makefile
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: With a container that never becomes ready, the target fails with a clear message before pytest.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-23 [#148](https://github.com/epittman23/local-llm/issues/148): make backend does not wait for Postgres before the app runs migrations at import

- Severity / status / effort: Low / Suspected / S
- Locations: `Makefile:92`; `infra/docker-compose.yml:25-41`; `apps/server/local_llm/config.py:52-70`
- Root cause: No readiness wait.
- Recommended fix: Add a `pg_isready` healthcheck and use `up -d --wait postgres`.
- Files likely to change: Makefile, infra/docker-compose.yml
- Regression risks: Low.
- Docs to update: README "Running it" if behaviour changes.
- Acceptance criteria: `make backend` against a fresh volume starts on the first try.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-24 [#149](https://github.com/epittman23/local-llm/issues/149): Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files

- Severity / status / effort: Low / Confirmed / S
- Locations: `.pre-commit-config.yaml:10-14`; `.pre-commit-config.yaml:49`; `MAP.md:14-30`; `MAP.md:336-342`
- Root cause: Docs not updated with #80 and later layout changes.
- Recommended fix: Delete the stale bullet; add MAP.md entries and fix the cross-reference.
- Files likely to change: .pre-commit-config.yaml, MAP.md
- Regression risks: None.
- Docs to update: These files.
- Acceptance criteria: `make lint` green; every tracked top-level entry appears in MAP.md.

#### A-32 [#157](https://github.com/epittman23/local-llm/issues/157): Flaky e2e assertion in the knowledge list search test

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/web/e2e/workspace-knowledge.spec.ts:156-172`
- Root cause: Non-polling assertion on request log after a UI condition.
- Recommended fix: Use `expect.poll(() => calls.some(...)).toBe(true)` or wait for the request.
- Files likely to change: apps/web/e2e/workspace-knowledge.spec.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: The spec passes repeatedly under `--repeat-each=20 --workers=2`.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B12 Frontend foundations: UUIDs and API error handling

#### A-115 [#241](https://github.com/epittman23/local-llm/issues/241): crypto.randomUUID is unavailable over plain-HTTP LAN access, so sending a chat message throws there

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/web/src/lib/chat/history.ts:59`; `apps/web/src/lib/chat/history.ts:98`; `apps/web/src/lib/chat/history.ts:130`; `apps/web/src/lib/chat/history.ts:483`; `apps/web/src/routes/chat/useChatSession.ts:437`; `apps/web/src/lib/utils/auth-helpers.ts:84`; `apps/web/src/routes/channels/MessageComposer.tsx:169`; `apps/web/src/routes/channels/useMessageFeed.ts:158`; `apps/web/src/routes/admin/settings/banners.ts:6`; `apps/web/src/routes/admin/settings/Integrations.tsx:160`
- Root cause: `crypto.randomUUID` is secure-context only and was adopted without a fallback.
- Recommended fix: Add a small UUID helper that falls back to a `getRandomValues`-based v4 and use it everywhere.
- Files likely to change: apps/web/src/lib/chat/history.ts, apps/web/src/routes/chat/useChatSession.ts, apps/web/src/lib/utils/auth-helpers.ts, apps/web/src/routes/channels/MessageComposer.tsx, apps/web/src/routes/channels/useMessageFeed.ts, apps/web/src/routes/admin/settings/banners.ts, apps/web/src/routes/admin/settings/Integrations.tsx
- Regression risks: Ids must stay RFC 4122 v4 so the backend and existing data accept them.
- Docs to update: docs/decisions.md (a dated entry replacing the 2026-09 choice of `crypto.randomUUID`); README.md LAN note under "Running it".
- Acceptance criteria: Vitest with `crypto.randomUUID` deleted: sending a message still works; a grep shows no direct `crypto.randomUUID` calls.

#### A-114 [#240](https://github.com/epittman23/local-llm/issues/240): API client helpers resolve null on network or non-JSON errors, so failures are reported as success or lost silently

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/web/src/lib/apis/channels/index.ts:389-396`; `apps/web/src/lib/apis/channels/index.ts:532-539`; `apps/web/src/routes/channels/useMessageFeed.ts:181-185`; `apps/web/src/routes/channels/MessageComposer.tsx:209-212`; `apps/web/src/lib/apis/retrieval/index.ts:56-81`; `apps/web/src/lib/apis/retrieval/index.ts:137-162`; `apps/web/src/routes/admin/settings/Documents.tsx:131-132`; `apps/web/src/routes/admin/settings/Documents.tsx:162-163`; `apps/web/src/lib/settings/useConfigDraft.ts:21`; `apps/web/src/lib/settings/useConfigDraft.ts:46`
- Root cause: The shared helper pattern reads `err.detail`, which network and non-JSON errors lack.
- Recommended fix: Change the shared pattern to `throw err?.detail ?? err` (or a readable fallback) and treat `null` as an error where callers rely on it; fix `useConfigDraft` to surface a null load as an error.
- Files likely to change: apps/web/src/lib/apis/channels/index.ts, apps/web/src/routes/channels/useMessageFeed.ts, apps/web/src/routes/channels/MessageComposer.tsx, apps/web/src/lib/apis/retrieval/index.ts, apps/web/src/routes/admin/settings/Documents.tsx, apps/web/src/lib/settings/useConfigDraft.ts
- Regression risks: Callers that treat null as "not found" must be checked one by one; this touches many files.
- Docs to update: None.
- Acceptance criteria: Vitest: a failing fetch rejects for each touched helper; channel send keeps the text and shows an error.

### B13 Chat backend: streaming, persistence and provider conversion

#### A-36 [#162](https://github.com/epittman23/local-llm/issues/162): OpenRouter's mid-stream error chunk is ignored, so a cut-off reply is saved and shown as a complete answer

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:5031-5044`; `apps/server/local_llm/utils/middleware.py:5049-5070`
- Root cause: The error branch is gated on an empty `choices` list.
- Recommended fix: Check for a top-level `error` (or `finish_reason == 'error'`) before branching on `choices`; call `_save_error` and emit the error; add a characterization case.
- Files likely to change: apps/server/local_llm/utils/middleware.py
- Regression risks: Chunks with a null `error` key must not be treated as failures; the characterization fixtures pin the current stream handling.
- Docs to update: None.
- Acceptance criteria: Characterization test: the OpenRouter error chunk after a partial delta saves an error and emits `chat:completion {error}`.

#### A-37 [#163](https://github.com/epittman23/local-llm/issues/163): If the upstream connection drops mid-stream, the partial reply is discarded and the stream snapshot is never cleared

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:4859-4874`; `apps/server/local_llm/utils/middleware.py:5499-5516`; `apps/server/local_llm/main.py:1506-1531`; `apps/server/local_llm/main.py:1650-1662`; `apps/server/local_llm/utils/middleware.py:5568`; `apps/server/local_llm/utils/middleware.py:5610`
- Root cause: Only `CancelledError` is handled around the body iterator.
- Recommended fix: Catch non-cancellation exceptions in `run` like `_save_cancelled_state`: save the partial output with `done: true` plus the error, clear the stream, then report.
- Files likely to change: apps/server/local_llm/utils/middleware.py, apps/server/local_llm/main.py
- Regression risks: Must not double-report errors already saved by the error branch; keep cancellation behaviour unchanged.
- Docs to update: None.
- Acceptance criteria: Test: a body iterator that raises after one delta leaves the partial text and an error saved, and the stream cleared.

#### A-38 [#164](https://github.com/epittman23/local-llm/issues/164): Resuming after a tool approval rebuilds messages from the database, dropping the system prompt, injected context and the user's images

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/utils/middleware.py:3438-3458`; `apps/server/local_llm/utils/tool_approval.py:162-164`; `apps/server/local_llm/main.py:1627`
- Root cause: The resume path replaces the built message list with a database replay instead of extending it.
- Recommended fix: Keep the already-built system message and re-apply `_inline_message_images` (as `_replay_history_from_db` does), or splice the stored output into the built messages instead of replacing them.
- Files likely to change: apps/server/local_llm/utils/middleware.py, apps/server/local_llm/utils/tool_approval.py, apps/server/local_llm/main.py
- Regression risks: Tool outputs must still be spliced in order; check the tool-approval characterization fixtures.
- Docs to update: None.
- Acceptance criteria: Test: after an approved tool call the resumed request still carries the system message and the image part.

#### A-39 [#165](https://github.com/epittman23/local-llm/issues/165): A non-streaming reply with only tool calls, or with empty content, is never finished and spins forever

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:4139-4141`; `apps/server/local_llm/utils/middleware.py:4249-4252`
- Root cause: Finalization is conditional on non-empty content or output.
- Recommended fix: Always finalize: save `done: true` with whatever output exists (reasoning item, or an error explaining tools need streaming).
- Files likely to change: apps/server/local_llm/utils/middleware.py
- Regression risks: Do not save an empty reply as a successful answer; mark it with an explanatory error.
- Docs to update: None.
- Acceptance criteria: Test: both non-streaming cases save `done: true`.

#### A-40 [#166](https://github.com/epittman23/local-llm/issues/166): Tool arguments that are valid JSON but not an object crash the whole reply

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:4645-4655`; `apps/server/local_llm/utils/middleware.py:6040-6042`; `apps/server/local_llm/utils/middleware.py:3213-3238`
- Root cause: `_parse_tool_params` accepts any JSON value and callers assume a dict.
- Recommended fix: Treat any non-dict as unparseable in both places.
- Files likely to change: apps/server/local_llm/utils/middleware.py
- Regression risks: None (null arguments) must keep working as no arguments.
- Docs to update: None.
- Acceptance criteria: Test: `[]` arguments yield a tool error output and the reply continues.

#### A-41 [#167](https://github.com/epittman23/local-llm/issues/167): A Responses API `response.failed` event is shown live but not saved, so the reply looks successful after reload

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:4980-4986`; `apps/server/local_llm/utils/middleware.py:811-812`
- Root cause: The Responses API failure branch emits but does not persist the error.
- Recommended fix: Call `_save_error` in that branch; handle an empty error object.
- Files likely to change: apps/server/local_llm/utils/middleware.py
- Regression risks: Avoid emitting the error twice.
- Docs to update: None.
- Acceptance criteria: Test: `response.failed` saves the error.

#### A-42 [#168](https://github.com/epittman23/local-llm/issues/168): Task-model JSON is located with rfind('{'), so generated search queries or prompts containing a brace are mangled

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/middleware.py:1438`; `apps/server/local_llm/utils/middleware.py:1816`; `apps/server/local_llm/utils/middleware.py:1926`
- Root cause: JSON extraction uses `rfind('{')`.
- Recommended fix: Use `find('{')` / `json.JSONDecoder.raw_decode`, or reuse `_task_reply_json`.
- Files likely to change: apps/server/local_llm/utils/middleware.py
- Regression risks: Task models that wrap JSON in prose must still parse.
- Docs to update: None.
- Acceptance criteria: Test: a query containing braces round-trips intact.

#### A-61 [#187](https://github.com/epittman23/local-llm/issues/187): merge_system_messages keeps only the first text part of a list-content system message

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/misc.py:641-665`; `apps/server/local_llm/utils/misc.py:248-258`; `apps/server/local_llm/utils/middleware.py:179-182`; `apps/server/local_llm/utils/middleware.py:3170`; `apps/server/local_llm/utils/anthropic.py:158-172`
- Root cause: `get_content_from_message` returns only the first text part.
- Recommended fix: Join all text parts; pass a single system message through unchanged.
- Files likely to change: apps/server/local_llm/utils/misc.py, apps/server/local_llm/utils/middleware.py, apps/server/local_llm/utils/anthropic.py
- Regression risks: String system prompts must be unchanged; preserve cache_control where possible.
- Docs to update: None.
- Acceptance criteria: Test: a two-part system message keeps both parts.

#### A-62 [#188](https://github.com/epittman23/local-llm/issues/188): The Anthropic-compatible endpoint reports upstream failures as a successful end_turn

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/anthropic.py:526-530`; `apps/server/local_llm/utils/anthropic.py:659-660`; `apps/server/local_llm/utils/anthropic.py:884-896`; `apps/server/local_llm/utils/anthropic.py:403-425`
- Root cause: Unknown finish reasons map to end_turn and stream exceptions close the stream normally.
- Recommended fix: Emit Anthropic's `event: error` (`{type: error, error: {type: api_error, ...}}`), or at least not `end_turn`, when the chunk carries `error`/`finish_reason: error` or the source raises; return an error for the non-stream case.
- Files likely to change: apps/server/local_llm/utils/anthropic.py
- Regression risks: The stream must stay well-formed for clients (PR #87).
- Docs to update: None.
- Acceptance criteria: Tests for the three repro cases.

#### A-68 [#194](https://github.com/epittman23/local-llm/issues/194): Anthropic-to-OpenAI conversion drops top-level document and search_result blocks and ignores tool_choice none

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/anthropic.py:255-286`; `apps/server/local_llm/utils/anthropic.py:343-354`
- Root cause: The converter handles only five block types and maps `none` to omission.
- Recommended fix: Convert top-level documents/search results with the existing helpers; map `none` to `"none"`.
- Files likely to change: apps/server/local_llm/utils/anthropic.py
- Regression risks: Unknown block types should still be dropped or rejected consistently.
- Docs to update: None.
- Acceptance criteria: Tests for both cases.

#### A-164 [#290](https://github.com/epittman23/local-llm/issues/290): Files added to a message by tools or streamed images are written only to the chat JSON, so they are duplicated on save and lost on fork

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:1201-1268`; `apps/server/local_llm/models/chats.py:1077-1099`; `apps/server/local_llm/models/chats.py:1013-1064`; `apps/server/local_llm/utils/middleware.py:5187-5207`; `apps/server/local_llm/socket/main.py:1144-1157`; `apps/server/local_llm/routers/chats.py:1392`; `apps/server/local_llm/routers/chats.py:1410`
- Root cause: Two write paths update only the chat JSON while reads prefer chat_message rows.
- Recommended fix: Dual-write files and status_history through `ChatMessages.upsert_message`, fall back to the blob when the column is NULL, and emit only new files (or replace instead of extend).
- Files likely to change: apps/server/local_llm/models/chats.py, apps/server/local_llm/utils/middleware.py, apps/server/local_llm/socket/main.py, apps/server/local_llm/routers/chats.py
- Regression risks: The reconcile path must stay idempotent.
- Docs to update: None.
- Acceptance criteria: Tests for both repro cases.

#### A-70 [#196](https://github.com/epittman23/local-llm/issues/196): Every chat save re-adds a continued reply's usage to its chat_message row, inflating stored token usage without bound

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/chat_messages.py:243-246`; `apps/server/local_llm/models/chat_messages.py:297-323`; `apps/server/local_llm/models/chats.py:942-948`; `apps/server/local_llm/models/chats.py:988-1009`; `apps/server/local_llm/models/chats.py:1144`; `apps/server/local_llm/routers/chats.py:1077-1081`; `apps/server/local_llm/utils/middleware.py:4711`; `apps/server/local_llm/utils/middleware.py:5546-5565`; `apps/web/src/lib/chat/request.ts:212`
- Root cause: The chat_message upsert merges usage instead of replacing it, and continue starts from zero usage.
- Recommended fix: Overwrite usage on upsert (last writer wins) and accumulate only in the middleware, seeding `self.usage` from the stored message on continue.
- Files likely to change: apps/server/local_llm/models/chat_messages.py, apps/server/local_llm/models/chats.py, apps/server/local_llm/routers/chats.py, apps/server/local_llm/utils/middleware.py, apps/web/src/lib/chat/request.ts
- Regression risks: Multi-pass tool loops still need summed usage within one reply.
- Docs to update: None.
- Acceptance criteria: Test: repeated saves leave usage unchanged; a continue stores the cumulative usage in both places.

#### A-145 [#271](https://github.com/epittman23/local-llm/issues/271): The stop-sequence mapping corrupts non-ASCII stop strings and splits a string stop into characters

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/payload.py:191`; `apps/server/local_llm/utils/payload.py:245`; `apps/server/local_llm/routers/openai.py:1474`
- Root cause: The unescape step round-trips through latin-1 and treats strings as iterables.
- Recommended fix: Accept str or list and unescape only literal escape sequences (or drop the unescape).
- Files likely to change: apps/server/local_llm/utils/payload.py, apps/server/local_llm/routers/openai.py
- Regression risks: Escaped sequences like `\n` must still be unescaped.
- Docs to update: None.
- Acceptance criteria: Test: non-ASCII stops round-trip; a string stop stays one sequence.

#### A-48 [#174](https://github.com/epittman23/local-llm/issues/174): Resolving a tool approval twice can run the tool twice

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/utils/tool_approval.py:55-64`; `apps/server/local_llm/main.py:1868-1879`; `apps/server/local_llm/utils/middleware.py:3309-3316`
- Root cause: The resolve endpoint treats `queued` as unresolved, and approval is not compare-and-set.
- Recommended fix: Treat `approved is True` as resolved in the 409 check, or make approval a compare-and-set.
- Files likely to change: apps/server/local_llm/utils/tool_approval.py, apps/server/local_llm/main.py, apps/server/local_llm/utils/middleware.py
- Regression risks: A legitimate retry after a failed resume must still work.
- Docs to update: None.
- Acceptance criteria: Test: a second resolve of an approved call returns 409.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-46 [#172](https://github.com/epittman23/local-llm/issues/172): One invalid chat-variable value silently blanks every chat variable in the system prompt

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/chat_variables.py:243-253`; `apps/server/local_llm/utils/chat_variables.py:269-272`; `apps/server/local_llm/utils/payload.py:25-30`; `apps/server/local_llm/main.py:1139-1143`; `apps/server/local_llm/routers/chats.py:1066-1075`
- Root cause: Variables are validated as a set and any error discards the whole set.
- Recommended fix: Validate per field and drop (and log) only the offending variable; optionally validate on save.
- Files likely to change: apps/server/local_llm/utils/chat_variables.py, apps/server/local_llm/utils/payload.py, apps/server/local_llm/main.py, apps/server/local_llm/routers/chats.py
- Regression risks: Required-variable errors on send must still be reported.
- Docs to update: None.
- Acceptance criteria: Test: an invalid select value blanks only that variable.

#### A-47 [#173](https://github.com/epittman23/local-llm/issues/173): A filter's user valves leak to later filters through the shared `__user__` dict

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/filter.py:135-156`
- Root cause: The `__user__` dict is shared and mutated across filters.
- Recommended fix: Give each filter a copy: `{**params['__user__'], 'valves': ...}`.
- Files likely to change: apps/server/local_llm/utils/filter.py
- Regression risks: Filters that intentionally read `__user__` fields must still see them.
- Docs to update: None.
- Acceptance criteria: Test: filter B sees no valves.

### B14 Chat frontend

#### A-85 [#211](https://github.com/epittman23/local-llm/issues/211): Editing a reply or "Save As Copy" changes only what is displayed; the model keeps receiving the original text

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/web/src/lib/chat/history.ts:470-493`; `apps/web/src/lib/chat/history.ts:424`; `apps/web/src/lib/chat/history.ts:270-271`; `apps/web/src/routes/chat/useChatSession.ts:565`; `apps/web/src/routes/chat/useChatSession.ts:604`; `apps/server/local_llm/utils/middleware.py:2069`; `apps/server/local_llm/utils/middleware.py:2113-2133`
- Root cause: Edits write `content` while every consumer prefers `output`.
- Recommended fix: When the message has `output`, rewrite it (one message item holding the edited text) or drop it on edit; same for Save As Copy.
- Files likely to change: apps/web/src/lib/chat/history.ts, apps/web/src/routes/chat/useChatSession.ts, apps/server/local_llm/utils/middleware.py
- Regression risks: Messages without `output` must keep editing `content`; preserve reasoning items if rewriting output.
- Docs to update: None.
- Acceptance criteria: Vitest: after an edit, `toApiMessages` carries the edited text.

#### A-86 [#212](https://github.com/epittman23/local-llm/issues/212): With the message queue off, sending while a reply streams does not stop that reply

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:436-441`; `apps/web/src/components/settings/interfaceSettingDefs.ts:143-146`; `apps/web/src/routes/chat/ChatInput.tsx:409`
- Root cause: The interrupt (stop before send) step of the original was not ported.
- Recommended fix: `await stop()` before `send` in that branch.
- Files likely to change: apps/web/src/routes/chat/useChatSession.ts, apps/web/src/components/settings/interfaceSettingDefs.ts, apps/web/src/routes/chat/ChatInput.tsx
- Regression risks: Stop must settle before the new request to avoid two tasks.
- Docs to update: None.
- Acceptance criteria: Vitest: sending while generating with the queue off stops the current task first.

#### A-87 [#213](https://github.com/epittman23/local-llm/issues/213): A queued prompt is silently discarded when the reply it waited for fails with no content

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:447-453`; `apps/web/src/routes/chat/useChatSession.ts:393-396`; `apps/server/local_llm/main.py:1506-1530`
- Root cause: The queue item is removed before `send` decides whether to proceed.
- Recommended fix: Keep (or re-queue) the item when `send` declines, or skip the check for queued sends.
- Files likely to change: apps/web/src/routes/chat/useChatSession.ts, apps/server/local_llm/main.py
- Regression risks: Do not resend prompts the user cleared.
- Docs to update: None.
- Acceptance criteria: Vitest: a queued prompt survives a failed reply.

#### A-88 [#214](https://github.com/epittman23/local-llm/issues/214): A reply whose done event was missed (socket drop, sleep, backend reload) stays "generating" forever

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/web/src/lib/chat/history.ts:292-294`; `apps/web/src/routes/chat/useChatSession.ts:259-262`; `apps/web/src/lib/socket/SocketProvider.tsx`
- Root cause: The reconnect and inactive reconciliation of the original were not ported.
- Recommended fix: On inactive, reload the chat if the current leaf is not done; on reconnect, reload when a leaf is pending and the server reports no tasks.
- Files likely to change: apps/web/src/lib/chat/history.ts, apps/web/src/routes/chat/useChatSession.ts, apps/web/src/lib/socket/SocketProvider.tsx
- Regression risks: Reloading must not discard a reply that is still streaming.
- Docs to update: None.
- Acceptance criteria: Vitest: inactive with a pending leaf triggers a reload.

#### A-89 [#215](https://github.com/epittman23/local-llm/issues/215): An async message action or rating that finishes while another chat loads saves the old chat's history into the new chat

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:618-628`; `apps/web/src/routes/chat/useChatSession.ts:668-673`; `apps/web/src/routes/chat/useChatSession.ts:490-499`; `apps/web/src/routes/chat/useChatSession.ts:217-233`
- Root cause: Async actions save to the chat id current at save time, not the one they started in.
- Recommended fix: Capture the chat id at the start and bail or save to it explicitly; make `save` take the chat id.
- Files likely to change: apps/web/src/routes/chat/useChatSession.ts
- Regression risks: Actions that create a new chat must still adopt its id.
- Docs to update: None.
- Acceptance criteria: Vitest: an action completing after a chat switch does not save into the new chat.

#### A-90 [#216](https://github.com/epittman23/local-llm/issues/216): When the request fails in a multi-model chat, only the first column is marked failed and the input stays generating

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:359-363`; `apps/web/src/lib/chat/history.ts:120-146`
- Root cause: The catch path fails only the primary target.
- Recommended fix: Fail every target (or move `currentId` to the primary).
- Files likely to change: apps/web/src/routes/chat/useChatSession.ts, apps/web/src/lib/chat/history.ts
- Regression risks: Single-model behaviour must be unchanged.
- Docs to update: None.
- Acceptance criteria: Vitest: after a failed multi-model POST nothing is generating.

#### A-91 [#217](https://github.com/epittman23/local-llm/issues/217): Attachments and the typed draft carry over when switching chats

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/chat/useAttachments.ts:68`; `apps/web/src/routes/chat/ChatPage.tsx:194-196`
- Root cause: Attachment state is not keyed by chat.
- Recommended fix: Clear attachments and text on a route change, except when adopting a new chat id.
- Files likely to change: apps/web/src/routes/chat/useAttachments.ts, apps/web/src/routes/chat/ChatPage.tsx
- Regression risks: The new-chat adoption flow must keep its attachments.
- Docs to update: None.
- Acceptance criteria: Vitest: switching chats clears attachments.

#### A-92 [#218](https://github.com/epittman23/local-llm/issues/218): Queued prompts are discarded when switching chats

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:221`
- Root cause: The queue is a single list reset on navigation.
- Recommended fix: Key the queue by chat id (or warn before dropping).
- Files likely to change: apps/web/src/routes/chat/useChatSession.ts
- Regression risks: Queued prompts must not be sent into the wrong chat.
- Docs to update: None.
- Acceptance criteria: Vitest: a queued prompt survives a round trip to another chat.

#### A-93 [#219](https://github.com/epittman23/local-llm/issues/219): Image uploads to a non-vision model are no longer refused

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/chat/useAttachments.ts:201-202`
- Root cause: The capability check was downgraded to a warning.
- Recommended fix: Restore the refusal (or block send).
- Files likely to change: apps/web/src/routes/chat/useAttachments.ts
- Regression risks: Multi-model chats where one model has vision must still accept images.
- Docs to update: None.
- Acceptance criteria: Vitest: the image is refused.

#### A-94 [#220](https://github.com/epittman23/local-llm/issues/220): HEIC images are uploaded unconverted

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/chat/useAttachments.ts:139-150`
- Root cause: The conversion step was not ported.
- Recommended fix: Restore HEIC conversion (or reject HEIC with a message).
- Files likely to change: apps/web/src/routes/chat/useAttachments.ts
- Regression risks: Conversion library size; lazy-load it.
- Docs to update: None.
- Acceptance criteria: Vitest: a HEIC file is converted or rejected.

#### A-74 [#200](https://github.com/epittman23/local-llm/issues/200): Clearing a custom number parameter in chat controls stores "" and every later request sends it upstream as the value

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/components/common/AdvancedParams.tsx:49`; `apps/web/src/components/common/AdvancedParams.tsx:91`; `apps/web/src/routes/chat/ChatControls.tsx:79`; `apps/web/src/lib/chat/request.ts:192-196`; `apps/server/local_llm/utils/payload.py:118-121`
- Root cause: An empty number box is stored as "" rather than null, and chat params are not stripped before sending.
- Recommended fix: Map an empty number box to `null`, or strip `""`/`null` in `completionBody` and when chat params are saved.
- Files likely to change: apps/web/src/components/common/AdvancedParams.tsx, apps/web/src/routes/chat/ChatControls.tsx, apps/web/src/lib/chat/request.ts, apps/server/local_llm/utils/payload.py
- Regression risks: Explicit 0 values must still be sent.
- Docs to update: None.
- Acceptance criteria: Vitest: clearing the box yields no parameter in the request body.

### B15 Calendar, reminders and automations

#### A-45 [#171](https://github.com/epittman23/local-llm/issues/171): Recurring calendar occurrences that start before the viewed range are dropped, unlike one-off events with the same times

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/calendar.py:44`; `apps/server/local_llm/utils/calendar.py:69`; `apps/server/local_llm/models/calendar.py:562-571`; `apps/server/local_llm/utils/calendar.py:64-77`
- Root cause: Expansion keeps occurrences by start time instead of overlap.
- Recommended fix: Keep occurrences with start < range_end and start + duration > range_start; scan back by at least the event duration.
- Files likely to change: apps/server/local_llm/utils/calendar.py, apps/server/local_llm/models/calendar.py
- Regression risks: Week and month views must not show an occurrence twice when it spans the boundary.
- Docs to update: None.
- Acceptance criteria: Test: the Saturday view contains the weekend occurrence; the day view contains the overnight one.

#### A-50 [#176](https://github.com/epittman23/local-llm/issues/176): The calendar search tool returns unexpanded recurring events that push real in-range events out of the results

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:4184-4217`; `apps/server/local_llm/tools/builtin.py:4128-4145`; `apps/server/local_llm/models/calendar.py:577-579`; `apps/server/local_llm/routers/calendar.py:177-193`
- Root cause: The tool calls the range query without expanding recurring rows, unlike the router.
- Recommended fix: Expand recurring rows with `expand_recurring_event(..., tz=user tz)` as the router does, then filter, sort and count; include `rrule`.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/calendar.py, apps/server/local_llm/routers/calendar.py
- Regression risks: Expansion must honour the user timezone; keep the result count bounded.
- Docs to update: None.
- Acceptance criteria: Test: the in-range one-off event and the expanded occurrences in range are returned; nothing from 2020.

#### A-57 [#183](https://github.com/epittman23/local-llm/issues/183): Rescheduling an event never re-arms its reminder, and recurring events alert only once

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:4446-4469`; `apps/server/local_llm/models/calendar.py:719-720`; `apps/server/local_llm/utils/automations.py:719-721`; `apps/server/local_llm/utils/automations.py:749-752`; `apps/server/local_llm/models/calendar.py:731-787`; `apps/web/src/routes/calendar/calendarModel.ts:206`
- Root cause: Alert state is stored per event row, not per occurrence or start time.
- Recommended fix: Clear `alerted_at` when `start_at` changes, or store and compare the alerted occurrence start; alert per occurrence for recurring events.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/calendar.py, apps/server/local_llm/utils/automations.py, apps/web/src/routes/calendar/calendarModel.ts
- Regression risks: Do not re-alert an unchanged event on every poll.
- Docs to update: None.
- Acceptance criteria: Test: moving an alerted event re-arms its alert.

#### A-58 [#184](https://github.com/epittman23/local-llm/issues/184): Calendar reminders longer than 60 minutes fire 60 minutes before, although the tool offers them

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:4389`; `apps/server/local_llm/models/calendar.py:752-753`
- Root cause: The alert poll window is capped at 60 minutes.
- Recommended fix: Widen the poll window to the largest alert, or cap the tool at 60 and fix the docstring.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/calendar.py
- Regression risks: A wider window must not fire alerts early.
- Docs to update: None.
- Acceptance criteria: Test: a 120-minute alert is selected 120 minutes before.

#### A-142 [#268](https://github.com/epittman23/local-llm/issues/268): The app has no handler for the calendar:alert socket event, so in-app calendar reminders are never shown

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/automations.py:736-745`; `apps/web/src/routes/chat/useChatSession.ts:304`
- Root cause: The app-level listener of the original was not ported.
- Recommended fix: Add an app-level `events` listener for `calendar:alert` showing a toast and an optional Notification.
- Files likely to change: apps/server/local_llm/utils/automations.py, apps/web/src/routes/chat/useChatSession.ts
- Regression risks: Do not duplicate toasts across tabs (see the channel notification issue).
- Docs to update: None.
- Acceptance criteria: e2e with the fake socket: a calendar:alert event shows a toast.

#### A-56 [#182](https://github.com/epittman23/local-llm/issues/182): Creating an event without a calendar picks the first shared calendar flagged default, which can be another user's

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:4277-4284`; `apps/server/local_llm/models/calendar.py:310-333`; `apps/web/src/routes/calendar/calendarModel.ts:210-211`
- Root cause: `is_default` is the calendar owner's flag, but the lookup does not check ownership.
- Recommended fix: Prefer `c.user_id == user_id and c.is_default`, then the first owned calendar, in both places.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/calendar.py, apps/web/src/routes/calendar/calendarModel.ts
- Regression risks: Users with no own calendar still need a sensible fallback.
- Docs to update: None.
- Acceptance criteria: Test: the user's own default is chosen when a shared default exists.

#### A-138 [#264](https://github.com/epittman23/local-llm/issues/264): Automation runs are recorded as successful as soon as they are dispatched, so model and provider failures never reach the run history

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/utils/automations.py:468-491`; `apps/server/local_llm/utils/automations.py:654-678`; `apps/server/local_llm/main.py:1714-1720`; `apps/server/local_llm/main.py:1846-1847`
- Root cause: A synchronous success is assumed for an asynchronous handler.
- Recommended fix: Record the outcome from the background task (pass the automation id through metadata), or run automations as internal requests and inspect the result; record started at dispatch.
- Files likely to change: apps/server/local_llm/utils/automations.py, apps/server/local_llm/main.py
- Regression risks: Webhooks consumers may rely on the current event order.
- Docs to update: None.
- Acceptance criteria: Test with a failing handler: the run is recorded as error.

#### A-139 [#265](https://github.com/epittman23/local-llm/issues/265): Automation runs fired before the model list is loaded drop the model's default tools, filters, features and terminal

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/automations.py:308-318`; `apps/server/local_llm/utils/automations.py:440-466`; `apps/server/local_llm/utils/automations.py:623-650`; `apps/server/local_llm/main.py:365-369`; `apps/server/local_llm/config.py:326`; `apps/server/local_llm/routers/openai.py:350-358`
- Root cause: Model defaults are read from an in-memory list that is empty until a user request.
- Recommended fix: Call `get_all_models` when the model is missing from MODELS; consider starting the scheduler after the prefetch.
- Files likely to change: apps/server/local_llm/utils/automations.py, apps/server/local_llm/main.py, apps/server/local_llm/config.py, apps/server/local_llm/routers/openai.py
- Regression risks: Loading models at scheduler time must not block the event loop for long.
- Docs to update: None.
- Acceptance criteria: Test: with empty MODELS the defaults are still resolved.

#### A-140 [#266](https://github.com/epittman23/local-llm/issues/266): Daily, weekly and monthly automation rules skip occurrences when the user's timezone is behind the server's, and fire a few seconds late

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/automations.py:84`; `apps/server/local_llm/utils/automations.py:101-103`; `apps/server/local_llm/utils/automations.py:124-177`; `apps/server/local_llm/models/automations.py:345`; `apps/web/src/routes/automations/automationModel.ts:68-74`
- Root cause: rrulestr without DTSTART anchors at server-local now.
- Recommended fix: Pass an explicit dtstart in the user timezone (e.g. the anchor day) and default BYSECOND to 0.
- Files likely to change: apps/server/local_llm/utils/automations.py, apps/server/local_llm/models/automations.py, apps/web/src/routes/automations/automationModel.ts
- Regression risks: Rules that carry DTSTART must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test: the repro case yields today 10:00:00.

#### A-141 [#267](https://github.com/epittman23/local-llm/issues/267): Sub-daily rules with an old DTSTART are rebuilt from the epoch, reviving exhausted COUNT rules and shifting run times

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/automations.py:109-121`
- Root cause: Old rules are rebuilt from an epoch-aligned dtstart.
- Recommended fix: Keep the original dtstart for COUNT rules; otherwise realign by stepping from DTSTART.
- Files likely to change: apps/server/local_llm/utils/automations.py
- Regression risks: Performance of very old minutely rules must stay bounded.
- Docs to update: None.
- Acceptance criteria: Test: the exhausted rule has no next run.

#### A-144 [#270](https://github.com/epittman23/local-llm/issues/270): A chat timer stays "running" forever if anything fails before completion or the process restarts mid-claim

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/timers.py:171-199`; `apps/server/local_llm/utils/timers.py:230-414`
- Root cause: The timer body has no exception handling and nothing recovers stale running timers.
- Recommended fix: Wrap the body and mark errors; at startup re-pend or fail timers stuck in running.
- Files likely to change: apps/server/local_llm/utils/timers.py
- Regression risks: Do not refire timers whose run actually completed.
- Docs to update: None.
- Acceptance criteria: Test: an exception in the body marks the timer as error.

### B16 Knowledge, retrieval and files

#### A-69 [#195](https://github.com/epittman23/local-llm/issues/195): Deleting a knowledge directory with its contents leaves the files' chunks in the vector collection, so chat keeps answering from deleted files

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/models/knowledge.py:1003-1041`; `apps/server/local_llm/models/knowledge.py:1059-1069`; `apps/server/local_llm/routers/knowledge.py:2302-2341`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:265`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:487`; `apps/server/local_llm/routers/knowledge.py:1637-1655`
- Root cause: The directory delete path removes link rows only and does not run the file removal path.
- Recommended fix: Collect the subtree's file ids before deleting and run the single-file remove path for each (vectors by file_id and hash, File rows under the same retention rule).
- Files likely to change: apps/server/local_llm/models/knowledge.py, apps/server/local_llm/routers/knowledge.py, apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx
- Regression risks: Files shared with other bases must not lose their vectors there; respect the retention setting.
- Docs to update: None.
- Acceptance criteria: Router test with a fake vector client: deleting a directory with contents deletes vectors for every contained file.

#### A-71 [#197](https://github.com/epittman23/local-llm/issues/197): The Knowledge page's "local" source filter matches no knowledge base created in the app

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/knowledge.py:206-218`; `apps/server/local_llm/models/knowledge.py:296-302`; `apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:83-95`; `apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:212`
- Root cause: JSON null is stored for meta and the filter tests SQL NULL.
- Recommended fix: Use `coalesce(meta->>'source', '') != 'external'`, or declare the column `JSON(none_as_null=True)` for new rows.
- Files likely to change: apps/server/local_llm/models/knowledge.py, apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx
- Regression risks: External bases must still be excluded from local.
- Docs to update: None.
- Acceptance criteria: Test: a newly created base appears under local.

#### A-51 [#177](https://github.com/epittman23/local-llm/issues/177): query_chat_files without a file id returns only the first attached file's chunks

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:2593-2611`; `apps/server/local_llm/retrieval/utils.py:1685-1699`
- Root cause: Sources are concatenated per file in attachment order and truncated without ranking.
- Recommended fix: Flatten all chunks, sort by score (higher is better for pgvector), then slice; keep per-file order only in full-context mode.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: Full-context mode must keep per-file order.
- Docs to update: None.
- Acceptance criteria: Test: the higher-scoring file B chunks come first.

#### A-53 [#179](https://github.com/epittman23/local-llm/issues/179): query_knowledge_files lets attached notes and internal hits crowd out more relevant external knowledge hits

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:3357-3382`; `apps/server/local_llm/retrieval/external.py:300-321`
- Root cause: Results are concatenated by source type and truncated without ranking.
- Recommended fix: Merge internal and external hits by score before slicing and give notes their own budget.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/retrieval/external.py
- Regression risks: Notes attached explicitly must still be included.
- Docs to update: None.
- Acceptance criteria: Test: the 0.99 external hit is returned first.

#### A-54 [#180](https://github.com/epittman23/local-llm/issues/180): One failing external knowledge base makes query_knowledge_files fail and discards every internal result

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:3369-3382`; `apps/server/local_llm/retrieval/external.py:300-321`
- Root cause: No per-source error isolation.
- Recommended fix: Wrap each external retrieval in try/except, log, and continue.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/retrieval/external.py
- Regression risks: Report partial failures to the model so it does not over-trust the results.
- Docs to update: None.
- Acceptance criteria: Test: a failing external base still returns internal hits.

#### A-52 [#178](https://github.com/epittman23/local-llm/issues/178): Paging view_file / view_knowledge_file with line numbers skips content

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:2820-2842`; `apps/server/local_llm/tools/builtin.py:2963-2988`
- Root cause: The offset is computed from the line-numbered string instead of the raw slice.
- Recommended fix: Compute offsets from the raw slice before adding prefixes.
- Files likely to change: apps/server/local_llm/tools/builtin.py
- Regression risks: Pages without line numbers must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test: consecutive pages cover every line exactly once.

#### A-60 [#186](https://github.com/epittman23/local-llm/issues/186): Knowledge listing tools load every file's full text just to count files

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:2075-2076`; `apps/server/local_llm/tools/builtin.py:2135-2136`; `apps/server/local_llm/tools/builtin.py:3073-3074`; `apps/server/local_llm/models/knowledge.py:331-354`; `apps/server/local_llm/models/knowledge.py:636-647`
- Root cause: The tool loads full File rows to count them.
- Recommended fix: Use `file_count` (or metadata-only queries) and add an ORDER BY before paging.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/knowledge.py
- Regression risks: Counts must match what the UI shows.
- Docs to update: None.
- Acceptance criteria: Test or query count showing no File.data load.

#### A-150 [#276](https://github.com/epittman23/local-llm/issues/276): kb_exec ls lists a model's directly attached files inside every knowledge base

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/tools/knowledge_fs.py:402-421`; `apps/server/local_llm/tools/knowledge_fs.py:609-612`
- Root cause: Attached files are appended regardless of the requested knowledge id.
- Recommended fix: Skip direct attachments when `knowledge_id` is given.
- Files likely to change: apps/server/local_llm/tools/knowledge_fs.py
- Regression risks: Listing attached files alone must still work.
- Docs to update: None.
- Acceptance criteria: Test: a base listing contains only its own files.

#### A-103 [#229](https://github.com/epittman23/local-llm/issues/229): Knowledge-base actions can leave the user on an empty later page with no pagination to get back

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:215-218`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:344-354`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:390-406`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:501-510`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:702`; `apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts:69-82`
- Root cause: `init()` (reset to page 1) was ported as reload-only.
- Recommended fix: Call `setPage(1)` wherever the original called `init()`; clamp `page` to the last page when data arrives.
- Files likely to change: apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx, apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts
- Regression risks: Keep the current page when it still has items.
- Docs to update: None.
- Acceptance criteria: Vitest: both repro cases show page 1 content.

#### A-104 [#230](https://github.com/epittman23/local-llm/issues/230): The knowledge base detail page starts filtered by the list pages' shared View setting

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:150`; `apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:205`
- Root cause: The port reads a localStorage key the original did not read on this page.
- Recommended fix: Initialise the filter to '' as the original did.
- Files likely to change: apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx, apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx
- Regression risks: The list pages must keep remembering their filter.
- Docs to update: None.
- Acceptance criteria: Vitest: the first files query is unfiltered.

#### A-105 [#231](https://github.com/epittman23/local-llm/issues/231): Dropping a folder together with other items skips every item after the first folder

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:286-308`
- Root cause: DataTransfer items are read lazily after an await.
- Recommended fix: Collect all entries and files synchronously before the first await.
- Files likely to change: apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx
- Regression risks: Single-folder drops must be unchanged.
- Docs to update: None.
- Acceptance criteria: A browser test dropping a folder plus a file uploads both.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-106 [#232](https://github.com/epittman23/local-llm/issues/232): Hybrid search is silently switched off when the reranker fails to load, while Documents reports it saved and on

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/retrieval.py:164-220`; `apps/server/local_llm/routers/retrieval.py:1180-1197`; `apps/server/local_llm/routers/retrieval.py:1338`; `apps/web/src/routes/admin/settings/Documents.tsx:162-163`
- Root cause: A reranker load failure is turned into a silent flag change and the tab ignores the response.
- Recommended fix: Return an error or warning instead of silently flipping the flag; have Documents reload from the response and warn when a flag came back different.
- Files likely to change: apps/server/local_llm/routers/retrieval.py, apps/web/src/routes/admin/settings/Documents.tsx
- Regression risks: Saving without hybrid search must not try to load the reranker.
- Docs to update: None.
- Acceptance criteria: Router test: a failing reranker load is reported; Vitest: the toggle reflects the response.

#### A-107 [#233](https://github.com/epittman23/local-llm/issues/233): Admin Documents: the BM25 weight "Default" option can never be saved

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Documents.tsx:594`; `apps/web/src/routes/admin/settings/Documents.tsx:624`; `apps/web/src/routes/admin/settings/documents.ts:83-101`; `apps/server/local_llm/routers/retrieval.py:976-978`
- Root cause: null means "keep" on the server but "default" in the UI.
- Recommended fix: Send 0.5 for Default, or drop the toggle since the server has no null state.
- Files likely to change: apps/web/src/routes/admin/settings/Documents.tsx, apps/web/src/routes/admin/settings/documents.ts, apps/server/local_llm/routers/retrieval.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: Default sends 0.5.

#### A-108 [#234](https://github.com/epittman23/local-llm/issues/234): Admin Documents: JSON options pass validation then fail the save after the embedding change was already applied

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/documents.ts:50-77`; `apps/web/src/routes/admin/settings/Documents.tsx:161-162`
- Root cause: Validation depends on the current engine and the embedding is applied first.
- Recommended fix: Validate every JSON box as an object regardless of engine and build the payload before applying the embedding.
- Files likely to change: apps/web/src/routes/admin/settings/documents.ts, apps/web/src/routes/admin/settings/Documents.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: invalid JSON blocks the save before any request.

#### A-109 [#235](https://github.com/epittman23/local-llm/issues/235): Admin Documents accepts chunk size 0 or an overlap larger than the chunk size, after which every upload fails

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Documents.tsx:258-273`; `apps/server/local_llm/routers/retrieval.py:926-928`; `apps/server/local_llm/routers/retrieval.py:1212-1216`; `apps/server/local_llm/routers/retrieval.py:1713-1740`
- Root cause: No validation of chunk parameters.
- Recommended fix: Require chunk size >= 1 and overlap < size in the form and the server.
- Files likely to change: apps/web/src/routes/admin/settings/Documents.tsx, apps/server/local_llm/routers/retrieval.py
- Regression risks: Existing stored invalid values need a clear error.
- Docs to update: None.
- Acceptance criteria: Router test: invalid values return 400.

#### A-112 [#238](https://github.com/epittman23/local-llm/issues/238): "Max Upload Size" 0 means unlimited to the server but rejects every file in the chat and channel composers

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Documents.tsx:661-668`; `apps/server/local_llm/routers/files.py:382-383`; `apps/server/local_llm/routers/files.py:719-720`; `apps/web/src/routes/chat/useAttachments.ts:81-83`; `apps/web/src/routes/channels/MessageComposer.tsx:161-162`
- Root cause: Client and server give 0 different meanings.
- Recommended fix: Give 0 one meaning (treat as unlimited on the client, or require >= 1).
- Files likely to change: apps/web/src/routes/admin/settings/Documents.tsx, apps/server/local_llm/routers/files.py, apps/web/src/routes/chat/useAttachments.ts, apps/web/src/routes/channels/MessageComposer.tsx
- Regression risks: Existing deployments with 0 configured change behaviour on the client; note it.
- Docs to update: None.
- Acceptance criteria: Vitest: maxSize 0 allows uploads (or the form rejects 0).

#### A-132 [#258](https://github.com/epittman23/local-llm/issues/258): The pure-JS SHA-256 fallback is wrong for files of 512 MiB or more, so knowledge sync re-uploads them every time over plain HTTP

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/utils/hash.ts:167-175`; `apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts:27`; `apps/server/local_llm/routers/knowledge.py:1913`
- Root cause: The fallback writes only the low 32 bits of the length.
- Recommended fix: Also write the high word: `setUint32(padLen-8, Math.floor(bitLen / 2**32))`.
- Files likely to change: apps/web/src/lib/utils/hash.ts, apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts, apps/server/local_llm/routers/knowledge.py
- Regression risks: Digests for files under 512 MiB must be unchanged.
- Docs to update: None.
- Acceptance criteria: Unit test of the padding for a length above 2^32 bits (e.g. by testing the length-encoding helper).

### B17 Tool servers, MCP, OAuth and plugins

#### A-63 [#189](https://github.com/epittman23/local-llm/issues/189): OpenAPI tool servers: body fields that share a name with a path or query parameter are removed from the body (regression from #117)

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/utils/tools.py:1769-1774`; `apps/server/local_llm/utils/tools.py:1214-1219`
- Root cause: The #117 parameter filter removes every parameter name from the body.
- Recommended fix: Drop a name from the body only when it is not a property of the request-body schema; send it in both places when it is in both.
- Files likely to change: apps/server/local_llm/utils/tools.py
- Regression risks: Parameters that are not body properties must still be stripped.
- Docs to update: None.
- Acceptance criteria: Test: the stub server receives `id` in the body.

#### A-64 [#190](https://github.com/epittman23/local-llm/issues/190): OpenAPI tool servers: header and cookie parameters are offered to the model but never sent

- Severity / status / effort: Low / Confirmed / M
- Locations: `apps/server/local_llm/utils/tools.py:1180-1204`; `apps/server/local_llm/utils/tools.py:1705-1723`; `apps/server/local_llm/utils/tools.py:1771-1774`
- Root cause: Parameter routing ignores header and cookie locations.
- Recommended fix: Send `in: header` params as headers and `in: cookie` params as cookies.
- Files likely to change: apps/server/local_llm/utils/tools.py
- Regression risks: Do not let model-supplied headers override auth headers.
- Docs to update: None.
- Acceptance criteria: Test: the stub server receives the header.

#### A-65 [#191](https://github.com/epittman23/local-llm/issues/191): OpenAPI tool servers: an operation whose JSON body is an array produces an unusable tool

- Severity / status / effort: Low / Confirmed / M
- Locations: `apps/server/local_llm/utils/tools.py:1220-1221`; `apps/server/local_llm/utils/tools.py:1774-1777`
- Root cause: Array request bodies are used directly as the parameters schema.
- Recommended fix: Wrap the array in an object property and unwrap it when sending.
- Files likely to change: apps/server/local_llm/utils/tools.py
- Regression risks: Strict providers may reject the whole request today; verify after the fix.
- Docs to update: None.
- Acceptance criteria: Test: the server receives a JSON array.

#### A-66 [#192](https://github.com/epittman23/local-llm/issues/192): Without Redis, every tool-server and terminal-server lookup refetches every server spec

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/tools.py:1246-1264`; `apps/server/local_llm/utils/tools.py:1391-1412`; `apps/server/local_llm/utils/tools.py:382`; `apps/server/local_llm/routers/tools.py:104`; `apps/server/local_llm/main.py:413`
- Root cause: The in-process cache is ignored when Redis is absent.
- Recommended fix: Use the in-process cache when Redis is absent (it is already refreshed on config change).
- Files likely to change: apps/server/local_llm/utils/tools.py, apps/server/local_llm/routers/tools.py, apps/server/local_llm/main.py
- Regression risks: The cache must still refresh when tool-server config changes.
- Docs to update: None.
- Acceptance criteria: Test: repeated calls do not refetch.

#### A-49 [#175](https://github.com/epittman23/local-llm/issues/175): Custom connection headers with user-name or file-name placeholders break MCP connections for non-ASCII values

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/headers.py:137-151`; `apps/server/local_llm/utils/headers.py:72`; `apps/server/local_llm/utils/tools.py:171`; `apps/server/local_llm/utils/mcp/client.py`
- Root cause: Header placeholders are substituted without encoding.
- Recommended fix: Percent-encode substituted values (or RFC 8187).
- Files likely to change: apps/server/local_llm/utils/headers.py, apps/server/local_llm/utils/tools.py, apps/server/local_llm/utils/mcp/client.py
- Regression risks: Servers that expect the raw value need decoding guidance; keep ASCII values unchanged.
- Docs to update: None.
- Acceptance criteria: Test: a non-ASCII name yields an ASCII-safe header.

#### A-43 [#169](https://github.com/epittman23/local-llm/issues/169): Connected MCP clients leak when listing tools fails or a later tool-setup step raises

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/utils/middleware.py:2260-2273`; `apps/server/local_llm/utils/middleware.py:2662-2673`; `apps/server/local_llm/utils/middleware.py:2708-2720`; `apps/server/local_llm/utils/middleware.py:2726`; `apps/server/local_llm/utils/middleware.py:2770`; `apps/server/local_llm/utils/middleware.py:2872-2881`; `apps/server/local_llm/main.py:1549-1552`; `apps/server/local_llm/utils/mcp/client.py:84-87`
- Root cause: Clients are registered for cleanup only after every later setup step succeeds.
- Recommended fix: Disconnect on any failure after connect inside `connect_mcp_server`; register clients in metadata as soon as they connect, or clean up in try/finally.
- Files likely to change: apps/server/local_llm/utils/middleware.py, apps/server/local_llm/main.py, apps/server/local_llm/utils/mcp/client.py
- Regression risks: Disconnect must be idempotent; do not disconnect clients still in use by a concurrent request.
- Docs to update: None.
- Acceptance criteria: Test with a fake MCP client whose list_tools raises: disconnect is called.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-147 [#273](https://github.com/epittman23/local-llm/issues/273): MCP OAuth client registration picks a token auth method the client cannot use

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/oauth.py:541-549`; `apps/server/local_llm/utils/oauth.py:680-686`
- Root cause: The fallback ignores the supported set.
- Recommended fix: Pick the first offered method in the supported set, preferring a secret method when a secret exists.
- Files likely to change: apps/server/local_llm/utils/oauth.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: `client_secret_basic` is chosen.

#### A-148 [#274](https://github.com/epittman23/local-llm/issues/274): OAuth groups in a dotted claim name (Auth0-style URL claims) never resolve

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/oauth.py:1948-1953`; `apps/server/local_llm/utils/oauth.py:1852-1854`
- Root cause: Missing flat-key fallback.
- Recommended fix: Mirror the roles fallback.
- Files likely to change: apps/server/local_llm/utils/oauth.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a URL claim name resolves.

#### A-149 [#275](https://github.com/epittman23/local-llm/issues/275): OAuth group sync removes a new user from the default group immediately after adding them

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/oauth.py:2023-2039`; `apps/server/local_llm/utils/oauth.py:2270-2271`; `apps/server/local_llm/utils/oauth.py:2309-2316`
- Root cause: Sync treats every app group as IdP-managed.
- Recommended fix: Exclude the default (and locally managed) groups from OAuth removal, or apply the default after sync.
- Files likely to change: apps/server/local_llm/utils/oauth.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a new OAuth user stays in the default group.

#### A-158 [#284](https://github.com/epittman23/local-llm/issues/284): Every failed OAuth token refresh deletes the session, and refresh has no lock despite its docstring

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/oauth.py:1055-1064`; `apps/server/local_llm/utils/oauth.py:1071-1180`; `apps/server/local_llm/utils/oauth.py:1694-1735`; `apps/server/local_llm/models/oauth_sessions.py:259-294`
- Root cause: Any refresh failure deletes the session, and refresh is not serialized.
- Recommended fix: Delete only on a definitive invalid_grant/400/401; keep the session on transient errors; serialise refresh per session.
- Files likely to change: apps/server/local_llm/utils/oauth.py, apps/server/local_llm/models/oauth_sessions.py
- Regression risks: Revoked refresh tokens must still clear the session.
- Docs to update: None.
- Acceptance criteria: Test: a network error during refresh keeps the session.

#### A-159 [#285](https://github.com/epittman23/local-llm/issues/285): Non-expiring OAuth tokens become unusable on servers east of UTC

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/oauth.py:201`; `apps/server/local_llm/utils/oauth.py:230-247`; `apps/server/local_llm/utils/oauth.py:1050-1053`; `apps/server/local_llm/utils/oauth.py:1689-1692`; `apps/server/local_llm/models/oauth_sessions.py:123`
- Root cause: A naive local-time conversion of a far-future sentinel.
- Recommended fix: Compare epoch integers, or use an aware UTC conversion.
- Files likely to change: apps/server/local_llm/utils/oauth.py, apps/server/local_llm/models/oauth_sessions.py
- Regression risks: Normal expiring tokens must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test under TZ=Europe/Berlin.

#### A-160 [#286](https://github.com/epittman23/local-llm/issues/286): OAuth provider settings saved in Admin > Authentication are never used for login

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/auths.py:1037-1046`; `apps/server/local_llm/routers/auths.py:1100-1103`; `apps/server/local_llm/config.py:2390-2536`; `apps/server/local_llm/utils/oauth.py:829`; `apps/server/local_llm/routers/auths.py:699`; `apps/web/src/routes/admin/settings/Authentication.tsx:174-215`
- Root cause: Providers are registered once from environment values.
- Recommended fix: Build providers from the stored config at startup and after updates, or remove the fields from the form.
- Files likely to change: apps/server/local_llm/routers/auths.py, apps/server/local_llm/config.py, apps/server/local_llm/utils/oauth.py, apps/web/src/routes/admin/settings/Authentication.tsx
- Regression risks: Changing providers at runtime needs re-registration of the OIDC client.
- Docs to update: None.
- Acceptance criteria: Test: a saved provider URL is used to register the client.

#### A-161 [#287](https://github.com/epittman23/local-llm/issues/287): A 44-character LLLM_SECRET_KEY that is not a Fernet key stops the backend from starting

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/oauth_sessions.py:72-83`; `apps/server/local_llm/models/oauth_sessions.py:343`; `apps/server/local_llm/utils/oauth.py:253-263`; `apps/server/local_llm/env.py:777-779`
- Root cause: A 44-character key is assumed to be a Fernet key.
- Recommended fix: Try `Fernet(key)` and fall back to the SHA-256 derivation on ValueError (keeps working keys unchanged).
- Files likely to change: apps/server/local_llm/models/oauth_sessions.py, apps/server/local_llm/utils/oauth.py, apps/server/local_llm/env.py
- Regression risks: Keys that work today must derive the same Fernet key (stored ciphertext).
- Docs to update: None.
- Acceptance criteria: Test: a 44-character hex key starts.

#### A-162 [#288](https://github.com/epittman23/local-llm/issues/288): Tool valve saves report success when the database write failed

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/tools.py:257-309`; `apps/server/local_llm/routers/tools.py:836-843`; `apps/server/local_llm/routers/tools.py:975-983`
- Root cause: Model methods swallow exceptions and routes ignore the result.
- Recommended fix: Check the result and return an error; fix the annotation.
- Files likely to change: apps/server/local_llm/models/tools.py, apps/server/local_llm/routers/tools.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a failing write returns an error.

#### A-143 [#269](https://github.com/epittman23/local-llm/issues/269): Plugin import rewriting matches substrings, corrupting imports such as configparser and saving the corrupted source

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/plugin.py:228-242`; `apps/server/local_llm/utils/plugin.py:259-260`; `apps/server/local_llm/utils/plugin.py:357`; `apps/server/local_llm/utils/plugin.py:397-401`; `apps/server/local_llm/utils/plugin.py:438-442`; `apps/server/local_llm/routers/tools.py:396`; `apps/server/local_llm/routers/tools.py:538`; `apps/server/local_llm/routers/functions.py:176`; `apps/server/local_llm/routers/functions.py:222`; `apps/server/local_llm/routers/functions.py:392`
- Root cause: The rewrite uses substring replacement.
- Recommended fix: Match whole module names at line start, or drop the legacy rewrites now that the package alias exists.
- Files likely to change: apps/server/local_llm/utils/plugin.py, apps/server/local_llm/routers/tools.py, apps/server/local_llm/routers/functions.py
- Regression risks: Legacy plugins that import the old top-level names must still load.
- Docs to update: None.
- Acceptance criteria: Test: `from configparser import ConfigParser` is unchanged.

#### A-67 [#193](https://github.com/epittman23/local-llm/issues/193): Sub-agent limit -1 ("unlimited") breaks max_iterations and max_output

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/subagents.py:271-281`; `apps/server/local_llm/utils/subagents.py:563-564`; `apps/server/local_llm/utils/middleware.py:5631`; `apps/server/local_llm/utils/middleware.py:5656-5662`
- Root cause: Only the concurrency limits honour -1.
- Recommended fix: Treat -1 as unlimited for both, or reject it and fix the docstring.
- Files likely to change: apps/server/local_llm/utils/subagents.py, apps/server/local_llm/utils/middleware.py
- Regression risks: Positive limits must behave as before.
- Docs to update: None.
- Acceptance criteria: Test: -1 runs tools and keeps full output.

#### A-146 [#272](https://github.com/epittman23/local-llm/issues/272): With default model metadata set, admins lose base models that have no workspace row when admin bypass is off

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/models.py:297-300`; `apps/server/local_llm/utils/models.py:495-497`; `apps/server/local_llm/utils/models.py:525-536`
- Root cause: "Configured" is decided by `info` being truthy instead of a DB row existing.
- Recommended fix: Decide "configured" by whether a DB row exists, not by `info` being truthy.
- Files likely to change: apps/server/local_llm/utils/models.py
- Regression risks: Default bypass behaviour must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test: an admin sees a base model with default metadata.

### B18 Workspace and admin pages

#### A-95 [#221](https://github.com/epittman23/local-llm/issues/221): Saving a prompt with "Set as Production" unchecked still puts the new content live

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/models/prompts.py:509-524`; `apps/server/local_llm/models/prompts.py:547-550`; `apps/server/local_llm/models/prompts.py:441-475`; `apps/web/src/routes/workspace/prompts/PromptEditView.tsx:168`; `apps/web/src/routes/workspace/prompts/PromptEditView.tsx:185-194`; `apps/web/src/routes/chat/ChatInput.tsx:143`
- Root cause: Row fields are assigned before and regardless of the `is_production` check.
- Recommended fix: With `is_production` false, write only the history entry and leave the prompt row unchanged.
- Files likely to change: apps/server/local_llm/models/prompts.py, apps/web/src/routes/workspace/prompts/PromptEditView.tsx, apps/web/src/routes/chat/ChatInput.tsx
- Regression risks: Production saves must still update content immediately.
- Docs to update: None.
- Acceptance criteria: Test: a non-production save leaves `content` at the production snapshot.

#### A-96 [#222](https://github.com/epittman23/local-llm/issues/222): Switching the production prompt version reverts name and tags edited through the metadata path

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/prompts.py:556-583`; `apps/server/local_llm/models/prompts.py:606-613`; `apps/web/src/routes/workspace/prompts/PromptEditView.tsx:206-218`
- Root cause: Version restore copies name and tags from the snapshot while metadata edits bypass snapshots.
- Recommended fix: Restore only content (and data/meta) from the snapshot, or snapshot metadata edits; refresh the editor after a switch.
- Files likely to change: apps/server/local_llm/models/prompts.py, apps/web/src/routes/workspace/prompts/PromptEditView.tsx
- Regression risks: Restoring must still restore content.
- Docs to update: None.
- Acceptance criteria: Test: a version switch keeps the current name and tags.

#### A-97 [#223](https://github.com/epittman23/local-llm/issues/223): The prompt version diff endpoint is unreachable

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/prompts.py:636`; `apps/server/local_llm/routers/prompts.py:729`; `apps/web/src/lib/apis/prompts/index.ts:549`
- Root cause: Route registration order lets the history-entry route match first.
- Recommended fix: Register the diff route first, or delete it and its client.
- Files likely to change: apps/server/local_llm/routers/prompts.py, apps/web/src/lib/apis/prompts/index.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: the diff route matches.

#### A-98 [#224](https://github.com/epittman23/local-llm/issues/224): Importing a model JSON over an existing model deletes its sharing grants, re-enables it, and replaces its meta

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/models/ModelsPage.tsx:285-292`; `apps/web/src/routes/workspace/models/modelImport.ts:33-43`; `apps/web/src/lib/apis/models/index.ts:291-292`; `apps/server/local_llm/utils/access_control/__init__.py:234-235`; `apps/server/local_llm/models/models.py:183`; `apps/server/local_llm/models/models.py:547-553`; `apps/server/local_llm/models/access_grants.py:452-458`
- Root cause: The import sanitizer always sends empty grants and omits is_active on the update path.
- Recommended fix: Use the existing `importModels` client (`/models/import`), or omit `access_grants` and carry `is_active`.
- Files likely to change: apps/web/src/routes/workspace/models/ModelsPage.tsx, apps/web/src/routes/workspace/models/modelImport.ts, apps/web/src/lib/apis/models/index.ts, apps/server/local_llm/utils/access_control/__init__.py, apps/server/local_llm/models/models.py, apps/server/local_llm/models/access_grants.py
- Regression risks: New-model imports must keep sanitizing.
- Docs to update: None.
- Acceptance criteria: Vitest: re-importing an existing model sends no `access_grants` and keeps `is_active`; update `modelImport.test.ts:31`.

#### A-99 [#225](https://github.com/epittman23/local-llm/issues/225): Bulk Enable/Disable/Show/Hide on the Models page act on read-only models and can wipe their params

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/models/ModelsPage.tsx:239-272`; `apps/server/local_llm/routers/models.py:166-170`; `apps/server/local_llm/routers/models.py:192-193`; `apps/server/local_llm/routers/models.py:795`; `apps/server/local_llm/models/models.py:547-549`
- Root cause: Bulk handlers ignore write_access and send list rows as full bodies.
- Recommended fix: Act only on `write_access` rows and send full models (or a meta-only update).
- Files likely to change: apps/web/src/routes/workspace/models/ModelsPage.tsx, apps/server/local_llm/routers/models.py, apps/server/local_llm/models/models.py
- Regression risks: Admins must still be able to bulk-manage models they own.
- Docs to update: None.
- Acceptance criteria: Vitest: bulk actions skip read-only rows.

#### A-100 [#226](https://github.com/epittman23/local-llm/issues/226): Editing any prompt suggestion truncates all others to 2000 characters and drops their other fields

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:8`; `apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:15-24`; `apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:41-43`
- Root cause: Import normalization runs on every render and edit.
- Recommended fix: Apply limits only when importing.
- Files likely to change: apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx
- Regression risks: Imports must still be capped.
- Docs to update: None.
- Acceptance criteria: Vitest: editing one suggestion leaves the others unchanged.

#### A-101 [#227](https://github.com/epittman23/local-llm/issues/227): Saving a skill re-enables it if disabled and clears its tags

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/skills/SkillEditor.tsx:79-80`; `apps/web/src/routes/workspace/skills/SkillPages.tsx:92-99`; `apps/server/local_llm/routers/skills.py:316-318`; `apps/server/local_llm/models/skills.py:92`; `apps/server/local_llm/models/skills.py:316-320`
- Root cause: The editor hardcodes is_active and meta and the backend writes the whole form.
- Recommended fix: Carry `is_active` and `meta` through, or have the backend leave unset fields alone.
- Files likely to change: apps/web/src/routes/workspace/skills/SkillEditor.tsx, apps/web/src/routes/workspace/skills/SkillPages.tsx, apps/server/local_llm/routers/skills.py, apps/server/local_llm/models/skills.py
- Regression risks: New skills must still default to active.
- Docs to update: None.
- Acceptance criteria: Vitest: saving keeps is_active false and the tags.

#### A-102 [#228](https://github.com/epittman23/local-llm/issues/228): Debounced autosaves are cancelled on unmount, so edits made just before leaving a page are lost

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/workspace/prompts/PromptEditView.tsx:76`; `apps/web/src/routes/workspace/prompts/PromptEditView.tsx:137-163`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:230-250`
- Root cause: Timers are cleared on unmount instead of flushed.
- Recommended fix: Flush pending saves on unmount instead of cancelling them.
- Files likely to change: apps/web/src/routes/workspace/prompts/PromptEditView.tsx, apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx
- Regression risks: A flushed save must not run after the item was deleted.
- Docs to update: None.
- Acceptance criteria: Vitest: editing then leaving immediately still saves, for both pages.

#### A-77 [#203](https://github.com/epittman23/local-llm/issues/203): Leaderboard Elo ratings depend on database row order rather than time

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/feedbacks.py:315-319`; `apps/server/local_llm/routers/evaluations.py:79-126`; `apps/server/local_llm/routers/evaluations.py:221-227`
- Root cause: The leaderboard query has no ORDER BY and Elo is order dependent.
- Recommended fix: Order the query by `created_at, id`.
- Files likely to change: apps/server/local_llm/models/feedbacks.py, apps/server/local_llm/routers/evaluations.py
- Regression risks: Ratings change once (to chronological order); note it in the PR.
- Docs to update: None.
- Acceptance criteria: Test: ratings are identical for any input row order when sorted by time.

#### A-78 [#204](https://github.com/epittman23/local-llm/issues/204): Topic-weighted Elo uses raw cosine similarity, so a negative weight reverses a result

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/routers/evaluations.py:109`; `apps/server/local_llm/routers/evaluations.py:116-117`; `apps/server/local_llm/routers/evaluations.py:189-198`
- Root cause: Similarity weights are used unclamped.
- Recommended fix: Clamp the weight to `max(0, sim)`.
- Files likely to change: apps/server/local_llm/routers/evaluations.py
- Regression risks: Positive weights must behave as before.
- Docs to update: None.
- Acceptance criteria: Test: a negative similarity contributes nothing.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-152 [#278](https://github.com/epittman23/local-llm/issues/278): Leaderboard counts a thumbs-up on a regenerated reply as both a win and a loss for the same model

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/evaluations.py:111-124`; `apps/web/src/lib/chat/feedback.ts:72-86`
- Root cause: Opponent ids include the winner and empty ids.
- Recommended fix: Skip opponents equal to the winner or empty, on both sides of the seam.
- Files likely to change: apps/server/local_llm/routers/evaluations.py, apps/web/src/lib/chat/feedback.ts
- Regression risks: Arena feedback with distinct models must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test: a self-sibling feedback changes nothing.

#### A-79 [#205](https://github.com/epittman23/local-llm/issues/205): Sorting the Feedback table by User sends a key the backend ignores, leaving pages unordered

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/evaluations/Feedbacks.tsx:35`; `apps/web/src/routes/admin/evaluations/Feedbacks.tsx:62-64`; `apps/web/src/lib/apis/evaluations/index.ts:168`; `apps/server/local_llm/models/feedbacks.py:238`; `apps/server/local_llm/models/feedbacks.py:260`
- Root cause: The frontend column key 'user' does not match the backend's 'username'.
- Recommended fix: Use matching names and add `Feedback.id` as a secondary sort key.
- Files likely to change: apps/web/src/routes/admin/evaluations/Feedbacks.tsx, apps/web/src/lib/apis/evaluations/index.ts, apps/server/local_llm/models/feedbacks.py
- Regression risks: Other sort keys must be unchanged.
- Docs to update: None.
- Acceptance criteria: Router test: order_by=user sorts by username.

#### A-72 [#198](https://github.com/epittman23/local-llm/issues/198): The Analytics 24-hour chart ignores the group filter

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/analytics.py:208-209`; `apps/server/local_llm/models/chat_messages.py:1012-1053`; `apps/web/src/routes/admin/analytics/Analytics.tsx:134-139`
- Root cause: The hourly query has no group parameter.
- Recommended fix: Add `group_id` to the hourly query (same GroupMember subquery as daily) and pass it through.
- Files likely to change: apps/server/local_llm/routers/analytics.py, apps/server/local_llm/models/chat_messages.py, apps/web/src/routes/admin/analytics/Analytics.tsx
- Regression risks: Daily and hourly series must use the same group semantics.
- Docs to update: None.
- Acceptance criteria: Router test: the hourly series respects group_id.

#### A-73 [#199](https://github.com/epittman23/local-llm/issues/199): Paginated listings (users, group members, models, feedback) have no deterministic ORDER BY, so pages can repeat or skip rows

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/users.py:331-354`; `apps/server/local_llm/routers/users.py:115`; `apps/server/local_llm/routers/users.py:170`; `apps/server/local_llm/routers/channels.py:563`; `apps/server/local_llm/models/models.py:398-418`; `apps/web/src/routes/workspace/models/ModelsPage.tsx:226-238`; `apps/server/local_llm/models/feedbacks.py:230-262`; `apps/web/src/routes/admin/users/UserList.tsx:62-66`; `apps/web/src/routes/admin/users/GroupUsers.tsx:71-77`
- Root cause: ORDER BY columns are not unique and no primary-key tiebreaker is appended.
- Recommended fix: Append the primary key to every ORDER BY used with OFFSET paging (users, group members, models, feedback) and give filtered queries a default order.
- Files likely to change: apps/server/local_llm/models/users.py, apps/server/local_llm/routers/users.py, apps/server/local_llm/routers/channels.py, apps/server/local_llm/models/models.py, apps/web/src/routes/workspace/models/ModelsPage.tsx, apps/server/local_llm/models/feedbacks.py, apps/web/src/routes/admin/users/UserList.tsx, apps/web/src/routes/admin/users/GroupUsers.tsx
- Regression risks: Characterization fixtures pin the current SQL (#95); update them deliberately.
- Docs to update: None.
- Acceptance criteria: Characterization test shows the tiebreaker in the SQL.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-116 [#242](https://github.com/epittman23/local-llm/issues/242): JWT expiry accepts negative durations, locking every user out, and silently drops invalid values while the tab reports saved

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/routers/auths.py:946-950`; `apps/server/local_llm/utils/misc.py:1026-1054`; `apps/server/local_llm/routers/auths.py:161-175`; `apps/server/local_llm/utils/auth.py:119-130`; `apps/web/src/routes/admin/settings/Authentication.tsx:103-120`; `apps/web/src/routes/admin/settings/Authentication.tsx:333`
- Root cause: The pattern allows negative numbers and invalid values are dropped silently.
- Recommended fix: Require a positive number (or exactly -1/0), return 400 for invalid values, treat zero durations explicitly, and have the tab re-seed from the response or validate before sending.
- Files likely to change: apps/server/local_llm/routers/auths.py, apps/server/local_llm/utils/misc.py, apps/server/local_llm/utils/auth.py, apps/web/src/routes/admin/settings/Authentication.tsx
- Regression risks: Existing stored values like `-1` (no expiry) and `0` must keep their meaning.
- Docs to update: The field hint text in the Authentication tab.
- Acceptance criteria: Router test: `-1h` and `1 hour` return 400; `0s` is handled explicitly.

#### A-117 [#243](https://github.com/epittman23/local-llm/issues/243): Admin banners are saved but never displayed anywhere (the port lost the banner display and dismissal)

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/web/src/routes/admin/settings/General.tsx:151`; `apps/web/src/routes/admin/settings/General.tsx:163`; `apps/web/src/routes/admin/settings/Banners.tsx:66-71`; `apps/web/src/routes/admin/settings/banners.ts`
- Root cause: The banner display was deferred during the migration and never ported.
- Recommended fix: Render banners on the chat screen with remembered dismissal, or remove the editor and record the removal in docs/decisions.md.
- Files likely to change: apps/web/src/routes/admin/settings/General.tsx, apps/web/src/routes/admin/settings/Banners.tsx, apps/web/src/routes/admin/settings/banners.ts
- Regression risks: Banners must not cover the chat input on small screens.
- Docs to update: docs/decisions.md (a dated entry if banners are removed instead of displayed).
- Acceptance criteria: e2e: a saved banner appears on the chat page and stays dismissed after reload.

#### A-118 [#244](https://github.com/epittman23/local-llm/issues/244): Cancelling an Ollama pull deletes an installed model of the same name

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/models/ollamaDownloads.ts:113-123`; `apps/server/local_llm/routers/ollama.py:807-812`
- Root cause: Cancel deletes by name without an instance, and the backend resolves names to any instance.
- Recommended fix: Drop the delete (Ollama discards partial layers), or pass the pull's urlIdx and delete only if the tag was absent before the pull.
- Files likely to change: apps/web/src/routes/admin/settings/models/ollamaDownloads.ts, apps/server/local_llm/routers/ollama.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: cancelling a pull issues no delete for a previously installed tag.

#### A-119 [#245](https://github.com/epittman23/local-llm/issues/245): An Ollama pull whose stream errors spins forever and freezes the admin tab

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/models/ollamaDownloads.ts:81-101`
- Root cause: Read errors and parse errors share one catch that continues.
- Recommended fix: Break on reader errors; continue only on a JSON parse error of one line.
- Files likely to change: apps/web/src/routes/admin/settings/models/ollamaDownloads.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: an errored stream ends with one error toast.

#### A-120 [#246](https://github.com/epittman23/local-llm/issues/246): Ollama "Update All Models" reports success even when every pull failed

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/models/ManageOllama.tsx:164-185`
- Root cause: Errors are swallowed and success is unconditional.
- Recommended fix: Count failures and report them.
- Files likely to change: apps/web/src/routes/admin/settings/models/ManageOllama.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: failed pulls produce an error toast.

#### A-121 [#247](https://github.com/epittman23/local-llm/issues/247): Clearing the Jupyter timeout in admin Code Execution makes the tab unsaveable

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/CodeExecution.tsx:110-113`; `apps/server/local_llm/routers/configs.py:661`; `apps/server/local_llm/routers/configs.py:669`
- Root cause: Port regression: empty number stored as a string.
- Recommended fix: Map empty to null (use BoundNumber).
- Files likely to change: apps/web/src/routes/admin/settings/CodeExecution.tsx, apps/server/local_llm/routers/configs.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: clearing the field saves null.

#### A-122 [#248](https://github.com/epittman23/local-llm/issues/248): Clearing number fields in admin Interface settings fails the save and can half-apply it

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Interface.tsx:122`; `apps/web/src/routes/admin/settings/Interface.tsx:128-131`; `apps/web/src/routes/admin/settings/Interface.tsx:148`; `apps/server/local_llm/routers/tasks.py:119`; `apps/server/local_llm/routers/chats.py:160-162`
- Root cause: Form allows empty values the backend forms reject.
- Recommended fix: Require or default these fields in the form (or accept null as default on the server); render errors readably.
- Files likely to change: apps/web/src/routes/admin/settings/Interface.tsx, apps/server/local_llm/routers/tasks.py, apps/server/local_llm/routers/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: clearing the fields shows a validation message and sends nothing.

#### A-123 [#249](https://github.com/epittman23/local-llm/issues/249): After hiding a connection model with no stored record, further toggles on it fail until the tab is reopened

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/models/AdminModels.tsx:228-235`; `apps/web/src/routes/admin/settings/models/adminModels.ts:221-232`; `apps/server/local_llm/routers/models.py:272-277`
- Root cause: toggleHidden does not refresh recordIds after a create.
- Recommended fix: Call `init()` (or record the id) after a create in toggleHidden.
- Files likely to change: apps/web/src/routes/admin/settings/models/AdminModels.tsx, apps/web/src/routes/admin/settings/models/adminModels.ts, apps/server/local_llm/routers/models.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: the second toggle plans an update.

#### A-124 [#250](https://github.com/epittman23/local-llm/issues/250): GGUF upload creates the model twice in file mode and never in URL mode, and stream errors are swallowed

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/web/src/routes/admin/settings/models/ManageOllama.tsx:259-297`; `apps/server/local_llm/routers/ollama.py:1605`; `apps/server/local_llm/routers/ollama.py:1702-1718`
- Root cause: The client always creates a model after upload regardless of mode.
- Recommended fix: Skip the client create when `model_created` is present, create via `files`/`from` in URL mode, and toast stream errors.
- Files likely to change: apps/web/src/routes/admin/settings/models/ManageOllama.tsx, apps/server/local_llm/routers/ollama.py
- Regression risks: Experimental path; verify against a current Ollama.
- Docs to update: None.
- Acceptance criteria: Vitest: file mode issues no client create.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-125 [#251](https://github.com/epittman23/local-llm/issues/251): Pipelines: an unset list valve loads as an empty required Custom field, blocking Save; its test cannot catch it

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/pipelineValves.ts:10-11`; `apps/web/src/routes/admin/settings/Pipelines.tsx:269-318`; `apps/web/src/routes/admin/settings/pipelineValves.test.ts`
- Root cause: `valvesToForm` maps null to an empty string.
- Recommended fix: Keep null in `valvesToForm` and test the load-save round trip.
- Files likely to change: apps/web/src/routes/admin/settings/pipelineValves.ts, apps/web/src/routes/admin/settings/Pipelines.tsx, apps/web/src/routes/admin/settings/pipelineValves.test.ts
- Regression risks: Arrays with values must round-trip unchanged.
- Docs to update: None.
- Acceptance criteria: Vitest: load then save of a null valve yields null.

#### A-110 [#236](https://github.com/epittman23/local-llm/issues/236): Admin Images: Verify for the edit ComfyUI URL checks the generation server instead

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Images.tsx:269-273`; `apps/web/src/routes/admin/settings/Images.tsx:503-510`; `apps/server/local_llm/routers/images.py:329-360`
- Root cause: One verify endpoint serves two different settings.
- Recommended fix: Add a generation/edit target to the verify endpoint.
- Files likely to change: apps/web/src/routes/admin/settings/Images.tsx, apps/server/local_llm/routers/images.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: edit verification checks the edit URL.

#### A-111 [#237](https://github.com/epittman23/local-llm/issues/237): Admin Images: a cleared Steps field is sent as "" and fails the whole save

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Images.tsx:371-376`; `apps/web/src/routes/admin/settings/images.ts:107-131`; `apps/server/local_llm/routers/images.py:231`; `apps/server/local_llm/routers/images.py:292`
- Root cause: Empty number input stored as a string.
- Recommended fix: Store null for an empty box, validate before sending, and handle None on the server.
- Files likely to change: apps/web/src/routes/admin/settings/Images.tsx, apps/web/src/routes/admin/settings/images.ts, apps/server/local_llm/routers/images.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: an empty Steps box is not sent as a string.

#### A-113 [#239](https://github.com/epittman23/local-llm/issues/239): Admin Connections Save shows "Settings saved" after both saves failed

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/settings/Connections.tsx:247`; `apps/web/src/routes/admin/settings/Connections.tsx:261`; `apps/web/src/routes/admin/settings/Connections.tsx:290-293`
- Root cause: The save helpers swallow errors and the success toast is unconditional.
- Recommended fix: Return success from the helpers and call `saved()` only when both succeed.
- Files likely to change: apps/web/src/routes/admin/settings/Connections.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: no success toast when a save fails.

#### A-75 [#201](https://github.com/epittman23/local-llm/issues/201): A numeric enum valve sends its option as a string, so the backend rejects the save

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/components/common/Valves.tsx:111-119`; `apps/server/local_llm/routers/tools.py:832-834`
- Root cause: The select stores the DOM string value instead of the enum value.
- Recommended fix: Map the selected value back to the original `p.enum` entry before `set`.
- Files likely to change: apps/web/src/components/common/Valves.tsx, apps/server/local_llm/routers/tools.py
- Regression risks: String enums must be unchanged.
- Docs to update: None.
- Acceptance criteria: Vitest: selecting 2 yields the number 2.

#### A-76 [#202](https://github.com/epittman23/local-llm/issues/202): The note access dialog lost the original's permission props: no write grants, and a Public option that is silently stripped while the UI shows it applied

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/notes/NoteEditorPage.tsx:200-203`; `apps/web/src/routes/notes/NoteEditorPage.tsx:224-230`; `apps/web/src/components/common/AccessControlModal.tsx:11-15`; `apps/server/local_llm/routers/notes.py:643-649`
- Root cause: The port omitted the permission props the original passed and caches sent grants instead of the response.
- Recommended fix: Pass the same four props as the original and update the cache from the response.
- Files likely to change: apps/web/src/routes/notes/NoteEditorPage.tsx, apps/web/src/components/common/AccessControlModal.tsx, apps/server/local_llm/routers/notes.py
- Regression risks: Other AccessControlModal callers must keep their behaviour.
- Docs to update: None.
- Acceptance criteria: Vitest/e2e: the note access dialog offers write, hides Public without permission, and reflects the server response.

#### A-83 [#209](https://github.com/epittman23/local-llm/issues/209): Functions "Import JSON" reports success even when every create failed

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/admin/functions/FunctionsPage.tsx:207-214`
- Root cause: Per-item failures are caught and the success toast is unconditional.
- Recommended fix: Count successes and report "imported k of n" or an error.
- Files likely to change: apps/web/src/routes/admin/functions/FunctionsPage.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: all-failed import shows no success toast.

#### A-84 [#210](https://github.com/epittman23/local-llm/issues/210): A /notes?title=&content= link whose note creation fails leaves an endless spinner

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/notes/NotesPage.tsx:74-82`; `apps/web/src/routes/notes/NotesPage.tsx:149-155`
- Root cause: The create promise has no rejection or undefined-id handling.
- Recommended fix: Add the catch and undefined-id handling with a toast and a replace-navigation to /notes.
- Files likely to change: apps/web/src/routes/notes/NotesPage.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: a failed create navigates back with an error toast.

#### A-80 [#206](https://github.com/epittman23/local-llm/issues/206): A ?redirect= value with a control character passes safeRedirect, and the signed-in user is left on the sign-in form

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/auth/redirect.ts:8-10`; `apps/web/src/routes/public/AuthPage.tsx:62`; `apps/web/src/routes/public/AuthPage.tsx:79-81`; `apps/web/src/routes/public/AuthPage.tsx:138`; `apps/web/src/routes/public/AuthPage.tsx:157`
- Root cause: `safeRedirect` checks a denylist of prefixes instead of resolving the URL.
- Recommended fix: Resolve with `new URL(target, location.origin)` and accept only same-origin results (or reject control characters and backslashes); handle the navigate promise.
- Files likely to change: apps/web/src/lib/auth/redirect.ts, apps/web/src/routes/public/AuthPage.tsx
- Regression risks: Legitimate same-origin paths with query strings must still work.
- Docs to update: None.
- Acceptance criteria: Vitest: control-character targets fall back to `/`.

#### A-81 [#207](https://github.com/epittman23/local-llm/issues/207): Playground Cancel and leaving the page cannot abort a request before response headers arrive

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/playground/PlaygroundPages.tsx:114-128`; `apps/web/src/lib/apis/openai/index.ts:378-399`
- Root cause: The controller is created inside the API helper after the fetch resolves.
- Recommended fix: Create the AbortController before the fetch and pass its signal in.
- Files likely to change: apps/web/src/routes/playground/PlaygroundPages.tsx, apps/web/src/lib/apis/openai/index.ts
- Regression risks: Abort must not show an error toast.
- Docs to update: None.
- Acceptance criteria: Vitest: aborting before headers aborts the fetch.

#### A-82 [#208](https://github.com/epittman23/local-llm/issues/208): Playground parameters are spread at the top level of the request, so custom parameters never apply and app-only keys reach the provider

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/playground/playgroundModel.ts:66-81`; `apps/web/src/routes/playground/PlaygroundPages.tsx:184`; `apps/server/local_llm/utils/payload.py:85-113`; `apps/server/local_llm/main.py:1093`; `apps/server/local_llm/routers/openai.py:1642`
- Root cause: Playground params are spread into the body instead of nested under `params`.
- Recommended fix: Send `params: {...}` like the chat page.
- Files likely to change: apps/web/src/routes/playground/playgroundModel.ts, apps/web/src/routes/playground/PlaygroundPages.tsx, apps/server/local_llm/utils/payload.py, apps/server/local_llm/main.py, apps/server/local_llm/routers/openai.py
- Regression risks: Standard params must still reach the provider.
- Docs to update: None.
- Acceptance criteria: Vitest: the playground body nests params.

#### A-133 [#259](https://github.com/epittman23/local-llm/issues/259): Account tab: a failed load is silent, and Save then wipes user variables and profile fields

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/components/settings/personal/Account.tsx:79-95`; `apps/web/src/components/settings/personal/Account.tsx:102-129`; `apps/server/local_llm/routers/users.py:651-671`; `apps/server/local_llm/routers/auths.py:195-205`
- Root cause: Load errors are swallowed and Save is always enabled.
- Recommended fix: Track a load-error state, toast it, and disable Save until both loads succeed; never fall back to the store user for fields it lacks.
- Files likely to change: apps/web/src/components/settings/personal/Account.tsx, apps/server/local_llm/routers/users.py, apps/server/local_llm/routers/auths.py
- Regression risks: A genuinely empty variables list must still be savable.
- Docs to update: None.
- Acceptance criteria: Vitest: after a failed load, Save is disabled and nothing is posted.

#### A-134 [#260](https://github.com/epittman23/local-llm/issues/260): Enter in a password field on the Account tab runs the profile save instead of the password change

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/components/settings/personal/Account.tsx:292-330`
- Root cause: Port regression: the separate form was merged into the tab form.
- Recommended fix: Give the password section its own (sibling) form.
- Files likely to change: apps/web/src/components/settings/personal/Account.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: Enter in the password fields posts the password change.

#### A-135 [#261](https://github.com/epittman23/local-llm/issues/261): A font typed and submitted with Enter on the Interface tab is not saved

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/components/settings/InterfaceSettings.tsx:266-277`; `apps/web/src/components/settings/personal/Interface.tsx:42-50`; `apps/web/src/components/settings/controls.tsx:40-49`
- Root cause: Value committed on blur only.
- Recommended fix: Commit the font on change or flush it on submit.
- Files likely to change: apps/web/src/components/settings/InterfaceSettings.tsx, apps/web/src/components/settings/personal/Interface.tsx, apps/web/src/components/settings/controls.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: Enter saves the typed font.

#### A-136 [#262](https://github.com/epittman23/local-llm/issues/262): Personal settings switches fail silently, and the interface permission blocks every settings save while only one tab is hidden

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/components/settings/personal/Audio.tsx:118`; `apps/web/src/components/settings/personal/Personalization.tsx:147`; `apps/web/src/components/settings/personal/Notifications.tsx:109`; `apps/web/src/components/settings/personal/Shortcuts.tsx:64`; `apps/server/local_llm/routers/users.py:504-510`; `apps/web/src/components/settings/settingsTabs.ts:126-127`
- Root cause: Unhandled promise plus mismatched permission scope.
- Recommended fix: Catch and toast; decide the permission scope and align tab visibility with the backend gate.
- Files likely to change: apps/web/src/components/settings/personal/Audio.tsx, apps/web/src/components/settings/personal/Personalization.tsx, apps/web/src/components/settings/personal/Notifications.tsx, apps/web/src/components/settings/personal/Shortcuts.tsx, apps/server/local_llm/routers/users.py, apps/web/src/components/settings/settingsTabs.ts
- Regression risks: Changing the permission scope affects existing deployments; ask the owner.
- Docs to update: None.
- Acceptance criteria: Vitest: a 403 on save shows an error.

#### A-137 [#263](https://github.com/epittman23/local-llm/issues/263): A personal tool server saved without a name is listed as a blank row

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/components/settings/personal/Integrations.tsx:60`; `apps/web/src/components/settings/toolServerModel.ts:158-161`
- Root cause: Nullish coalescing on an empty string.
- Recommended fix: Use `||`.
- Files likely to change: apps/web/src/components/settings/personal/Integrations.tsx, apps/web/src/components/settings/toolServerModel.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: an unnamed server shows its URL.

#### A-154 [#280](https://github.com/epittman23/local-llm/issues/280): The workspace model tag filter matches models whose meta merely contains the tag word

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/models.py:387-396`
- Root cause: Substring match over serialized JSON.
- Recommended fix: Match within `meta.tags[*].name` only.
- Files likely to change: apps/server/local_llm/models/models.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: only the tagged model matches.

#### A-153 [#279](https://github.com/epittman23/local-llm/issues/279): Adding several users to a group silently drops new members when one is already a member

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/groups.py:586-600`; `apps/server/local_llm/models/groups.py:368-389`
- Root cause: Per-row flush with whole-transaction rollback.
- Recommended fix: Insert only non-members (or ON CONFLICT DO NOTHING).
- Files likely to change: apps/server/local_llm/models/groups.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: all new members are added.

### B19 Channels, notifications and chat data

#### A-126 [#252](https://github.com/epittman23/local-llm/issues/252): Failed channel message edits, pins, reactions and deletes stay on screen as if saved

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/channels/useMessageFeed.ts:211-238`; `apps/web/src/routes/channels/ChannelDialogs.tsx:99-103`; `apps/web/src/routes/channels/SidebarChannels.tsx:107-110`
- Root cause: Optimistic updates without rollback.
- Recommended fix: Keep the previous message and restore it on failure.
- Files likely to change: apps/web/src/routes/channels/useMessageFeed.ts, apps/web/src/routes/channels/ChannelDialogs.tsx, apps/web/src/routes/channels/SidebarChannels.tsx
- Regression risks: Live socket events arriving during the request must not be overwritten by the rollback.
- Docs to update: None.
- Acceptance criteria: Vitest: rejected actions roll back.

#### A-127 [#253](https://github.com/epittman23/local-llm/issues/253): A failed channel history load is shown as "the very beginning of the channel"

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/channels/useMessageFeed.ts:76-87`; `apps/web/src/routes/channels/useMessageFeed.ts:98-100`; `apps/web/src/routes/channels/MessageList.tsx:38-70`
- Root cause: Errors are mapped to an empty page.
- Recommended fix: Show an error and leave `top` false so a later scroll retries.
- Files likely to change: apps/web/src/routes/channels/useMessageFeed.ts, apps/web/src/routes/channels/MessageList.tsx
- Regression risks: Avoid tight retry loops.
- Docs to update: None.
- Acceptance criteria: Vitest: a failed loadMore can be retried.

#### A-128 [#254](https://github.com/epittman23/local-llm/issues/254): Every open tab shows its own desktop notification and sound for each channel message

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/channels/useChannels.ts:117-128`
- Root cause: The last-active-tab guard was not ported.
- Recommended fix: Restore a last-active-tab guard (BroadcastChannel) or set a notification tag.
- Files likely to change: apps/web/src/routes/channels/useChannels.ts
- Regression risks: The single remaining tab must still notify.
- Docs to update: None.
- Acceptance criteria: Vitest: only the active tab notifies.

#### A-129 [#255](https://github.com/epittman23/local-llm/issues/255): Channel unread badges count thread replies and model replies that the server does not count

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/channels/channelModel.ts:410-425`; `apps/web/src/routes/channels/useChannels.ts:117-124`; `apps/server/local_llm/models/messages.py:437-440`
- Root cause: Client and server count different message sets.
- Recommended fix: Skip events with `parent_id` (or count them on purpose and align the server).
- Files likely to change: apps/web/src/routes/channels/channelModel.ts, apps/web/src/routes/channels/useChannels.ts, apps/server/local_llm/models/messages.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: a thread reply does not change the badge.

#### A-130 [#256](https://github.com/epittman23/local-llm/issues/256): Pressing Enter on a mention suggestion that dropped out of the list throws and inserts nothing

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/channels/MessageComposer.tsx:143`; `apps/web/src/routes/channels/MessageComposer.tsx:218-232`
- Root cause: Selection index not clamped.
- Recommended fix: Clamp `selected` to the list length or skip a missing item.
- Files likely to change: apps/web/src/routes/channels/MessageComposer.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: Enter after the list shrinks picks a valid item.

#### A-131 [#257](https://github.com/epittman23/local-llm/issues/257): The reaction tooltip omits the fourth person when exactly four users reacted

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/channels/channelModel.ts:486-495`
- Root cause: Off-by-one threshold.
- Recommended fix: Use `total > 3` or list all four.
- Files likely to change: apps/web/src/routes/channels/channelModel.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: four reactors are all represented.

#### A-151 [#277](https://github.com/epittman23/local-llm/issues/277): Deleting a thread's parent message leaves its replies, pins and reactions reachable

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/messages.py:574-594`; `apps/server/local_llm/routers/channels.py:1771`; `apps/server/local_llm/tools/builtin.py:1845`
- Root cause: Delete removes only the message and its own reactions.
- Recommended fix: Delete replies and their reactions in the same transaction.
- Files likely to change: apps/server/local_llm/models/messages.py, apps/server/local_llm/routers/channels.py, apps/server/local_llm/tools/builtin.py
- Regression risks: Large threads: delete in one statement.
- Docs to update: None.
- Acceptance criteria: Test: after deleting a parent, its replies are gone from pins and search.

#### A-59 [#185](https://github.com/epittman23/local-llm/issues/185): view_channel_thread returns user_name null for every reply not posted by a webhook

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/tools/builtin.py:2003-2013`; `apps/server/local_llm/models/messages.py:229-244`; `apps/server/local_llm/models/messages.py:261`; `apps/server/local_llm/routers/channels.py:1469-1482`
- Root cause: The model method resolves user info only for webhook messages.
- Recommended fix: Batch-load users as the router does.
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/messages.py, apps/server/local_llm/routers/channels.py
- Regression risks: Keep webhook authors as they are.
- Docs to update: None.
- Acceptance criteria: Test: thread replies carry user names.

#### A-44 [#170](https://github.com/epittman23/local-llm/issues/170): One failing notification webhook stops delivery to the user's other notification targets

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/notifications.py:395-406`; `apps/server/local_llm/utils/notifications.py:259-260`
- Root cause: The try/except wraps the whole per-user target loop instead of each target.
- Recommended fix: Move the try/except inside the `for target` loop.
- Files likely to change: apps/server/local_llm/utils/notifications.py
- Regression risks: Keep one log line per failed target.
- Docs to update: None.
- Acceptance criteria: Test: a failing first target still lets the second receive the event.

#### A-163 [#289](https://github.com/epittman23/local-llm/issues/289): Postgres chat search silently excludes chats whose title contains "x00" or whose content contains a literal \u0000

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:2066-2071`
- Root cause: The LIKE patterns are written as if they were C escapes.
- Recommended fix: Delete both filters (writes already sanitize), or use `strpos(title, chr(0)) = 0`.
- Files likely to change: apps/server/local_llm/models/chats.py
- Regression risks: None (writes already strip null bytes).
- Docs to update: None.
- Acceptance criteria: Test against Postgres: a title containing 0x00 is found.

#### A-165 [#291](https://github.com/epittman23/local-llm/issues/291): Chat search ignores a folder: filter that matches no folder and returns every chat

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:1953-1957`; `apps/server/local_llm/models/chats.py:2000-2001`
- Root cause: Empty resolution treated as no filter.
- Recommended fix: Return nothing when a folder token resolves to no folder.
- Files likely to change: apps/server/local_llm/models/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: an unknown folder returns no chats.

#### A-166 [#292](https://github.com/epittman23/local-llm/issues/292): LIKE wildcards in chat search text are not escaped, so % or _ matches every chat

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:2016-2017`; `apps/server/local_llm/models/chats.py:68-99`; `apps/server/local_llm/models/chats.py:1391`; `apps/server/local_llm/models/chats.py:1471`
- Root cause: Unescaped user input in LIKE patterns.
- Recommended fix: Escape `\`, `%`, `_` and use an ESCAPE clause (or `autoescape=True`).
- Files likely to change: apps/server/local_llm/models/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: `%` matches only chats containing a percent sign.

#### A-167 [#293](https://github.com/epittman23/local-llm/issues/293): Linking an already-linked file to a chat makes the whole chat_file batch fail, so new files are never linked

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:2549-2553`; `apps/server/local_llm/models/chats.py:2578-2602`; `apps/server/local_llm/utils/access_control/files.py:95`
- Root cause: Wrong field used for de-duplication.
- Recommended fix: De-duplicate on file_id across the chat, or ON CONFLICT DO NOTHING per row.
- Files likely to change: apps/server/local_llm/models/chats.py, apps/server/local_llm/utils/access_control/files.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: G is linked.

#### A-168 [#294](https://github.com/epittman23/local-llm/issues/294): Chat export pages by OFFSET over updated_at, so a chat updated during export is skipped and another exported twice

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:1845-1892`; `apps/server/local_llm/routers/chats.py:686-703`
- Root cause: OFFSET paging over a column that changes during the export.
- Recommended fix: Keyset-page on an immutable key, or snapshot ids first.
- Files likely to change: apps/server/local_llm/models/chats.py, apps/server/local_llm/routers/chats.py
- Regression risks: Export order may change; document it.
- Docs to update: None.
- Acceptance criteria: Test: concurrent update during export still exports every chat once.

#### A-169 [#295](https://github.com/epittman23/local-llm/issues/295): Imported chats all show as unread

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/chats.py:601-618`; `apps/server/local_llm/models/chats.py:120`; `apps/server/local_llm/models/chats.py:526`; `apps/server/local_llm/models/chats.py:1800`
- Root cause: The import path never sets last_read_at.
- Recommended fix: Set `last_read_at = updated_at` on import.
- Files likely to change: apps/server/local_llm/models/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: imported chats are read.

#### A-157 [#283](https://github.com/epittman23/local-llm/issues/283): Generated tags that differ only by case or spacing make the whole tag batch fail, leaving chat tags unindexed and unarchive returning 500

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/models/tags.py:121-134`; `apps/server/local_llm/models/chats.py:840-849`; `apps/server/local_llm/utils/middleware.py:3854-3860`; `apps/server/local_llm/routers/chats.py:1615`
- Root cause: Names are normalized to ids without de-duplication.
- Recommended fix: De-duplicate by normalised id in `ensure_tags_exist` and in `update_chat_tags_by_id`.
- Files likely to change: apps/server/local_llm/models/tags.py, apps/server/local_llm/models/chats.py, apps/server/local_llm/utils/middleware.py, apps/server/local_llm/routers/chats.py
- Regression risks: Keep the first display name.
- Docs to update: None.
- Acceptance criteria: Test: duplicate-normalising names create one tag.

#### A-156 [#282](https://github.com/epittman23/local-llm/issues/282): Batch memory replace clears the memory's path unless the caller repeats it

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/utils/memory.py:264-270`; `apps/server/local_llm/models/memories.py:227-228`; `apps/server/local_llm/routers/memories.py:86-91`; `apps/server/local_llm/routers/memories.py:243-256`; `apps/server/local_llm/tools/builtin.py:962-997`; `apps/server/local_llm/utils/memory.py:545-547`
- Root cause: model_dump without exclude_unset and an unconditional path assignment.
- Recommended fix: Use `model_dump(exclude_unset=True)` and normalise path only when present.
- Files likely to change: apps/server/local_llm/utils/memory.py, apps/server/local_llm/models/memories.py, apps/server/local_llm/routers/memories.py, apps/server/local_llm/tools/builtin.py
- Regression risks: Explicitly clearing a path must still be possible.
- Docs to update: None.
- Acceptance criteria: Test: a replace without path keeps the existing path.

#### A-55 [#181](https://github.com/epittman23/local-llm/issues/181): search_notes and search_chats apply date filters after fetching only the newest matches, so older ranges return nothing

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/tools/builtin.py:1153-1175`; `apps/server/local_llm/tools/builtin.py:1533-1551`; `apps/server/local_llm/models/notes.py:269`; `apps/server/local_llm/models/chats.py:2101-2104`
- Root cause: Date filters are applied in Python after a newest-first LIMIT.
- Recommended fix: Push the date range into the SQL queries (add parameters to the model methods).
- Files likely to change: apps/server/local_llm/tools/builtin.py, apps/server/local_llm/models/notes.py, apps/server/local_llm/models/chats.py
- Regression risks: Text search ranking must stay the same.
- Docs to update: None.
- Acceptance criteria: Test: the 5 older matches are returned.

#### A-155 [#281](https://github.com/epittman23/local-llm/issues/281): Folder delete commits child deletions one by one and reports a mid-way failure as success

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/folders.py:394-415`; `apps/server/local_llm/routers/folders.py:692-704`
- Root cause: Each child is committed separately and exceptions are swallowed.
- Recommended fix: One transaction for the subtree; let exceptions propagate.
- Files likely to change: apps/server/local_llm/models/folders.py, apps/server/local_llm/routers/folders.py
- Regression risks: Very large trees: keep one transaction bounded.
- Docs to update: None.
- Acceptance criteria: Test with an injected failure: nothing is deleted and the route errors.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B20 Run modes, startup, shutdown and the chat backend (final wave)

#### A-171 [#297](https://github.com/epittman23/local-llm/issues/297): With LLLM_BACKEND_HOST=0.0.0.0, Socket.IO refuses every connection from a LAN origin, so chat replies never reach the page

- Severity / status / effort: High / Confirmed / S
- Locations: `Makefile:101`; `apps/server/local_llm/config.py:1889`; `apps/server/local_llm/socket/main.py:63`; `apps/server/local_llm/socket/main.py:91`; `apps/server/local_llm/socket/main.py:106`; `apps/server/local_llm/main.py:1855-1859`; `apps/web/src/routes/chat/useChatSession.ts:348`
- Root cause: The origin allow-list is fixed to loopback origins while the bind host is configurable.
- Recommended fix: Accept same-origin socket connections (engineio's own default) in addition to the configured list, or have the Makefile add the LAN origin when the host is not loopback; keep the HTTP API's origin list as it is.
- Files likely to change: Makefile, apps/server/local_llm/config.py, apps/server/local_llm/socket/main.py, apps/server/local_llm/main.py, apps/web/src/routes/chat/useChatSession.ts
- Regression risks: Coordinate with B0; see the advisories.
- Docs to update: README.md "Running it" LAN note and the AGENTS.md Commands line for `LLLM_BACKEND_HOST=0.0.0.0`.
- Acceptance criteria: A test (or `make -n backend` plus a socket handshake check) shows a LAN origin accepted when bound to 0.0.0.0.

#### A-172 [#298](https://github.com/epittman23/local-llm/issues/298): Stopping a chat's tasks skips some when three or more are running, but reports all stopped

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/tasks.py:114-139`; `apps/server/local_llm/tasks.py:163-169`; `apps/server/local_llm/tasks.py:257-282`; `apps/server/local_llm/main.py:1714`; `apps/server/local_llm/main.py:2139`; `apps/server/local_llm/routers/chats.py:1294`; `apps/server/local_llm/routers/chats.py:1299`; `apps/server/local_llm/routers/chats.py:1610`
- Root cause: Mutating a list while iterating over it across awaits.
- Recommended fix: Iterate over a copy of the list.
- Files likely to change: apps/server/local_llm/tasks.py, apps/server/local_llm/main.py, apps/server/local_llm/routers/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: stopping an item with four tasks cancels all four.

#### A-173 [#299](https://github.com/epittman23/local-llm/issues/299): The default avatar endpoint returns 500 because user.png is never seeded into the static directory

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/users.py:876`; `apps/server/local_llm/routers/users.py:888`; `apps/server/local_llm/config.py:103-138`; `apps/server/local_llm/models/users.py:363`; `apps/server/local_llm/models/auths.py:79`
- Root cause: Port regression: the file moved out of the seeded directory.
- Recommended fix: Seed `user.png` into STATIC_DIR or serve the fallback from the frontend build.
- Files likely to change: apps/server/local_llm/routers/users.py, apps/server/local_llm/config.py, apps/server/local_llm/models/users.py, apps/server/local_llm/models/auths.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the endpoint returns 200 with an image for a default user.

#### A-174 [#300](https://github.com/epittman23/local-llm/issues/300): /openai/audio/speech returns 500 because an error-message function is passed uncalled

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/openai.py:612`; `apps/server/local_llm/routers/openai.py:671`; `apps/server/local_llm/constants.py:124`
- Root cause: Missing call parentheses.
- Recommended fix: Call it and use a non-401 status.
- Files likely to change: apps/server/local_llm/routers/openai.py, apps/server/local_llm/constants.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the route returns the error message.

#### A-175 [#301](https://github.com/epittman23/local-llm/issues/301): An empty RAG_FILE_MAX_SIZE crashes startup, and the metadata cap ignores the admin upload limit

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/env.py:745-752`; `apps/server/local_llm/config.py:707`; `apps/server/local_llm/retrieval/vector/utils.py:28`; `apps/server/local_llm/retrieval/vector/utils.py:50`
- Root cause: Two independent parsers for one setting.
- Recommended fix: Treat empty as unset; derive the cap from `rag.file.max_size` at use time (or document env-only).
- Files likely to change: apps/server/local_llm/env.py, apps/server/local_llm/config.py, apps/server/local_llm/retrieval/vector/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: an empty value imports; the cap follows the admin setting.

#### A-233 [#359](https://github.com/epittman23/local-llm/issues/359): In multi-model chats every column after the first runs with the first model's parameters and system prompt state

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/main.py:1085-1096`; `apps/server/local_llm/main.py:1698-1705`; `apps/server/local_llm/main.py:1769`; `apps/server/local_llm/main.py:1799-1828`; `apps/server/local_llm/utils/payload.py:69-121`; `apps/server/local_llm/routers/openai.py:1471-1476`; `apps/server/local_llm/utils/middleware.py:2959-2961`
- Root cause: Per-request param merge done once for the primary model.
- Recommended fix: Deep-copy per model and compute params, stream settings and capabilities from each target's model info.
- Files likely to change: apps/server/local_llm/main.py, apps/server/local_llm/utils/payload.py, apps/server/local_llm/routers/openai.py, apps/server/local_llm/utils/middleware.py
- Regression risks: Single-model chats must be unchanged.
- Docs to update: None.
- Acceptance criteria: Test: each target uses its own params.

#### A-234 [#360](https://github.com/epittman23/local-llm/issues/360): The custom-model fallback setting does nothing for UI chats, because the fan-out restores the broken model

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/main.py:1698-1705`; `apps/server/local_llm/main.py:1757`; `apps/server/local_llm/main.py:1772-1790`; `apps/server/local_llm/main.py:1859-1860`; `apps/server/local_llm/routers/openai.py:1463-1467`
- Root cause: Fallback applied before the fan-out overwrites it.
- Recommended fix: Carry the fallback substitution into the message targets, or resolve it per entry.
- Files likely to change: apps/server/local_llm/main.py, apps/server/local_llm/routers/openai.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the fan-out uses the fallback model.

#### A-235 [#361](https://github.com/epittman23/local-llm/issues/361): SAFE_MODE does not stop event functions from running at startup

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/main.py:341-350`; `apps/server/local_llm/events.py:1101-1166`; `apps/server/local_llm/models/functions.py:418-430`
- Root cause: Startup ordering.
- Recommended fix: Deactivate (and check the result) before the first publish, or skip dispatch in SAFE_MODE.
- Files likely to change: apps/server/local_llm/main.py, apps/server/local_llm/events.py, apps/server/local_llm/models/functions.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: in SAFE_MODE no event function runs at startup.

#### A-236 [#362](https://github.com/epittman23/local-llm/issues/362): Shutdown closes the HTTP pool without stopping running chat tasks, so in-flight replies are cut instead of saved as cancelled

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/main.py:430-442`; `apps/server/local_llm/utils/session_pool.py:86-92`; `apps/server/local_llm/utils/middleware.py:5513-5515`; `apps/server/local_llm/utils/middleware.py:5588-5615`
- Root cause: Shutdown order.
- Recommended fix: Cancel and await running chat tasks before closing the pool.
- Files likely to change: apps/server/local_llm/main.py, apps/server/local_llm/utils/session_pool.py, apps/server/local_llm/utils/middleware.py
- Regression risks: Bound the wait so shutdown cannot hang.
- Docs to update: None.
- Acceptance criteria: Test: a running task is saved as cancelled on shutdown.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-237 [#363](https://github.com/epittman23/local-llm/issues/363): A tool-server connection saved with config null stops the backend from starting

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/main.py:559`; `apps/server/local_llm/main.py:594`; `apps/server/local_llm/routers/configs.py:220`; `apps/server/local_llm/routers/configs.py:256-258`; `apps/server/local_llm/utils/tools.py:1228-1233`
- Root cause: Null not handled.
- Recommended fix: Treat null as `{}` or reject it on save.
- Files likely to change: apps/server/local_llm/main.py, apps/server/local_llm/routers/configs.py, apps/server/local_llm/utils/tools.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a null config does not break startup.

#### A-238 [#364](https://github.com/epittman23/local-llm/issues/364): Upstream failures on the direct API path all become HTTP 400

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/main.py:1637-1638`; `apps/server/local_llm/main.py:1650-1661`
- Root cause: Blanket exception conversion.
- Recommended fix: Preserve the upstream status.
- Files likely to change: apps/server/local_llm/main.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a 429 from upstream is returned as 429.

### B21 Knowledge files and folders (final wave)

#### A-181 [#307](https://github.com/epittman23/local-llm/issues/307): Saving a knowledge file's edited content reports success when nothing, or only part of it, was saved

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/routers/files.py:718-766`; `apps/server/local_llm/routers/retrieval.py:1864-1867`; `apps/server/local_llm/routers/retrieval.py:1886`; `apps/server/local_llm/routers/retrieval.py:1989-2017`; `apps/server/local_llm/routers/retrieval.py:2080-2117`; `apps/server/local_llm/utils/access_control/files.py:50-63`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:390-405`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:732-733`; `apps/server/local_llm/routers/knowledge.py:1549-1564`; `apps/server/local_llm/routers/knowledge.py:1451-1465`; `apps/server/local_llm/routers/retrieval.py:3183-3191`; `apps/server/local_llm/routers/retrieval.py:1880`
- Root cause: The route and `process_file` disagree on who may modify a file, and exceptions are swallowed.
- Recommended fix: Make `process_file`'s lookup accept callers who pass `has_access_to_file` (or reject non-owners up front); propagate failures as errors and return the stored content.
- Files likely to change: apps/server/local_llm/routers/files.py, apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/utils/access_control/files.py, apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx
- Regression risks: Do not widen file write access beyond what `has_access_to_file` already grants.
- Docs to update: None.
- Acceptance criteria: Router tests: a grantee's save is stored (or rejected with an error); a processing failure returns an error.

#### A-182 [#308](https://github.com/epittman23/local-llm/issues/308): "Reindex knowledge" deletes every vector up front and reports success even when files fail to re-embed

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/knowledge.py:380-443`; `apps/web/src/routes/admin/settings/Documents.tsx:171-179`
- Root cause: Destructive delete-first rebuild with failures only logged.
- Recommended fix: Return totals and failures (or a non-2xx status) and show them; delete per file only after its re-embed succeeds.
- Files likely to change: apps/server/local_llm/routers/knowledge.py, apps/web/src/routes/admin/settings/Documents.tsx
- Regression risks: Long reindexes should stay off the event loop.
- Docs to update: None.
- Acceptance criteria: Router test: a failing embed is reported.

#### A-183 [#309](https://github.com/epittman23/local-llm/issues/309): Knowledge files whose processing is interrupted stay "uploading" forever

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/files.py:226`; `apps/server/local_llm/routers/files.py:404`; `apps/server/local_llm/routers/files.py:424-434`; `apps/server/local_llm/models/files.py:408-444`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:173`; `apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:187-199`; `apps/server/local_llm/routers/knowledge.py:1633`
- Root cause: Process-local background work with no recovery.
- Recommended fix: At startup mark stale pending/processing files failed (or requeue them); ignore rows older than a timeout.
- Files likely to change: apps/server/local_llm/routers/files.py, apps/server/local_llm/models/files.py, apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx, apps/server/local_llm/routers/knowledge.py
- Regression risks: Do not fail files a live worker is still processing.
- Docs to update: None.
- Acceptance criteria: Test: a stale pending file is marked failed at startup.

#### A-184 [#310](https://github.com/epittman23/local-llm/issues/310): A failed knowledge-base step leaves an orphan file, so folder sync leaks a file on every run for identical-content files

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/files.py:191-256`; `apps/server/local_llm/routers/retrieval.py:1661-1679`; `apps/server/local_llm/routers/knowledge.py:1890-1926`; `apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts:214`; `apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts:248`
- Root cause: No rollback of the first stage when the second fails; sync compares paths while the base de-duplicates by content.
- Recommended fix: Delete the file (storage and file collection) when its base step fails; treat a matching checksum already in the base as unmodified.
- Files likely to change: apps/server/local_llm/routers/files.py, apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/routers/knowledge.py, apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts
- Regression risks: Do not delete files that are linked elsewhere.
- Docs to update: None.
- Acceptance criteria: Test: a duplicate-content upload leaves no orphan.

#### A-185 [#311](https://github.com/epittman23/local-llm/issues/311): The upload status stream can report completed before the knowledge-base step and link finish

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/routers/retrieval.py:2054-2058`; `apps/server/local_llm/routers/files.py:224-241`; `apps/server/local_llm/routers/files.py:630-644`
- Root cause: Sub-steps write the terminal status.
- Recommended fix: Write `completed` once, after the link.
- Files likely to change: apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/routers/files.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test with a slowed publish: the stream reports completed only after linking.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-186 [#312](https://github.com/epittman23/local-llm/issues/312): Knowledge directories at the root can share a name, and sync then ignores one of them

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/knowledge.py:74-76`; `apps/server/local_llm/routers/knowledge.py:2241-2252`; `apps/server/local_llm/routers/knowledge.py:1875-1888`; `apps/server/local_llm/routers/knowledge.py:1936-1939`
- Root cause: NULL parent ids escape the unique constraint.
- Recommended fix: Check siblings by name in create/update, or add a partial unique index for root (new migration).
- Files likely to change: apps/server/local_llm/models/knowledge.py, apps/server/local_llm/routers/knowledge.py
- Regression risks: Existing duplicates need handling before adding an index.
- Docs to update: None.
- Acceptance criteria: Router test: a second root folder with the same name is rejected.

#### A-187 [#313](https://github.com/epittman23/local-llm/issues/313): Removing a file from one knowledge base (or resetting one) deletes it even when another base uses it

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/knowledge.py:1656-1657`; `apps/server/local_llm/routers/knowledge.py:1807`; `apps/server/local_llm/routers/knowledge.py:1815-1817`; `apps/server/local_llm/routers/knowledge.py:1993-1999`
- Root cause: Inconsistent guard across delete paths.
- Recommended fix: Apply the same linked-bases guard as sync cleanup.
- Files likely to change: apps/server/local_llm/routers/knowledge.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: removing from one base keeps the file for the other.

#### A-188 [#314](https://github.com/epittman23/local-llm/issues/314): Adding an already-linked file to a knowledge base duplicates its chunks and reports success; batch-add warnings are dropped

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/knowledge.py:1459-1474`; `apps/server/local_llm/routers/knowledge.py:2076-2081`; `apps/server/local_llm/routers/knowledge.py:2118-2127`; `apps/server/local_llm/models/knowledge.py:695-705`
- Root cause: Missing guard; response model mismatch.
- Recommended fix: Add the `has_file` guard to the single route; add a warnings field to the response model.
- Files likely to change: apps/server/local_llm/routers/knowledge.py, apps/server/local_llm/models/knowledge.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router tests for both cases.

#### A-189 [#315](https://github.com/epittman23/local-llm/issues/315): Deleting a shared chat folder leaves other users' chats pointing at it, hidden from their sidebars

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/folders.py:692-701`; `apps/server/local_llm/models/chats.py:2486-2519`; `apps/server/local_llm/models/chats.py:1524-1525`
- Root cause: Chat cleanup filters by folder owner.
- Recommended fix: Move every chat in the deleted folder ids to root regardless of owner.
- Files likely to change: apps/server/local_llm/routers/folders.py, apps/server/local_llm/models/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a grantee chat is moved to root.

#### A-190 [#316](https://github.com/epittman23/local-llm/issues/316): Deleting a folder while keeping its chats still requires the chat delete permission

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/folders.py:675-684`
- Root cause: Unconditional permission check.
- Recommended fix: Check the permission only when deleting contents.
- Files likely to change: apps/server/local_llm/routers/folders.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: keep-contents delete works without the permission.

#### A-191 [#317](https://github.com/epittman23/local-llm/issues/317): Folder sync removes the old copy of a modified file before the new one has uploaded

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts:242-250`; `apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts:50-53`
- Root cause: Cleanup ordered before uploads.
- Recommended fix: Clean up a modified file's old id only after its replacement succeeded.
- Files likely to change: apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts, apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: a failed replacement keeps the old file.

### B22 Retrieval engine and memories (final wave)

#### A-220 [#346](https://github.com/epittman23/local-llm/issues/346): An embedding model that fails to load is saved and reported as updated, after which every upload and query fails

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/retrieval.py:141-161`; `apps/server/local_llm/routers/retrieval.py:530-617`; `apps/server/local_llm/retrieval/utils.py:1109-1116`
- Root cause: Load errors are swallowed and the old model is unloaded first.
- Recommended fix: Load the new model before unloading the old one, return an error on failure, and save only on success.
- Files likely to change: apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: Model loading must stay off the event loop.
- Docs to update: None.
- Acceptance criteria: Router test: an unloadable model returns an error and keeps the old model.

#### A-221 [#347](https://github.com/epittman23/local-llm/issues/347): Native pgvector hybrid search requires every query word to match, so keyword ranking rarely contributes and weight 1.0 returns nothing

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:566`; `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:570-596`; `apps/server/local_llm/retrieval/vector/utils.py:64-121`; `apps/server/local_llm/retrieval/utils.py:420-450`; `apps/server/local_llm/retrieval/utils.py:497-509`
- Root cause: AND semantics of `plainto_tsquery` and no empty-result fallback.
- Recommended fix: Use an OR query (e.g. `websearch_to_tsquery` or terms joined with `|`), rank with `ts_rank_cd`, and fall back when full-text returns nothing.
- Files likely to change: apps/server/local_llm/retrieval/vector/dbs/pgvector.py, apps/server/local_llm/retrieval/vector/utils.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: Ranking changes; compare results on a sample base.
- Docs to update: None.
- Acceptance criteria: Test against Postgres: a multi-word question returns keyword hits.

#### A-222 [#348](https://github.com/epittman23/local-llm/issues/348): The external reranker has no default timeout, and its failures silently skip reranking, top-k and the relevance threshold

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/models/external.py:253`; `apps/server/local_llm/retrieval/models/external.py:283-303`; `apps/server/local_llm/config.py:776`; `apps/server/local_llm/routers/retrieval.py:174`; `apps/server/local_llm/retrieval/utils.py:1789-1812`
- Root cause: No default timeout; failures mapped to pass-through.
- Recommended fix: Use a finite default timeout; on failure surface the error or still apply top_n and the threshold sensibly.
- Files likely to change: apps/server/local_llm/retrieval/models/external.py, apps/server/local_llm/config.py, apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Tests for the timeout and the failure path.

#### A-223 [#349](https://github.com/epittman23/local-llm/issues/349): External knowledge bases answer only the first of several generated queries

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/external.py:327-364`; `apps/server/local_llm/utils/middleware.py:1910-1952`; `apps/server/local_llm/retrieval/utils.py:1537-1545`
- Root cause: Truncation after concatenation.
- Recommended fix: Merge all queries' hits, de-duplicate, sort by a normalised score, then cut.
- Files likely to change: apps/server/local_llm/retrieval/external.py, apps/server/local_llm/utils/middleware.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: q2's better hits are returned.

#### A-224 [#350](https://github.com/epittman23/local-llm/issues/350): The external pgvector provider sends the query vector as double precision[], so queries likely fail

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/retrieval/external.py:233`; `apps/server/local_llm/retrieval/external.py:256-278`
- Root cause: Wrong parameter type.
- Recommended fix: Pass `pgvector.Vector(vector)` or cast `%s::vector`; convert distance to similarity.
- Files likely to change: apps/server/local_llm/retrieval/external.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test against a pgvector database: a query returns rows.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-225 [#351](https://github.com/epittman23/local-llm/issues/351): In chat, one failing attachment or external knowledge base silently drops the context of every attachment

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/utils.py:1530-1545`; `apps/server/local_llm/retrieval/utils.py:1685-1697`; `apps/server/local_llm/retrieval/external.py:299-321`; `apps/server/local_llm/retrieval/external.py:361-362`; `apps/server/local_llm/utils/middleware.py:1953-1987`
- Root cause: No per-item error isolation.
- Recommended fix: Isolate each item in try/except and emit a status naming the failed source.
- Files likely to change: apps/server/local_llm/retrieval/utils.py, apps/server/local_llm/retrieval/external.py, apps/server/local_llm/utils/middleware.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a failing external base still returns the file source.

#### A-226 [#352](https://github.com/epittman23/local-llm/issues/352): pgvector query, get and search leave the thread's session in an open transaction when nothing matches

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:522-539`; `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:641-648`; `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:680-687`
- Root cause: Cleanup skipped on early return.
- Recommended fix: Release in `try/finally` on every return path.
- Files likely to change: apps/server/local_llm/retrieval/vector/dbs/pgvector.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: no connection checked out after an empty query.

#### A-227 [#353](https://github.com/epittman23/local-llm/issues/353): An embedding batch size of 0 or less is accepted and breaks every embedding

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/retrieval.py:509`; `apps/server/local_llm/routers/retrieval.py:538`; `apps/server/local_llm/retrieval/utils.py:1121`; `apps/server/local_llm/retrieval/utils.py:1147`; `apps/web/src/routes/admin/settings/Documents.tsx:429`
- Root cause: Missing validation.
- Recommended fix: Validate `>= 1` in the form and the UI.
- Files likely to change: apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/retrieval/utils.py, apps/web/src/routes/admin/settings/Documents.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: 0 is rejected.

#### A-228 [#354](https://github.com/epittman23/local-llm/issues/354): The collection query API ignores hybrid=false, and r=0 or k_reranker=0 cannot override the configuration

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/retrieval.py:2898-2899`; `apps/server/local_llm/routers/retrieval.py:2950-2985`; `apps/server/local_llm/retrieval/utils.py:710-729`
- Root cause: Global config re-read and falsy checks.
- Recommended fix: Pass an explicit flag and use `is not None` checks.
- Files likely to change: apps/server/local_llm/routers/retrieval.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: hybrid=false runs vector-only.

#### A-229 [#355](https://github.com/epittman23/local-llm/issues/355): Full-context reads of a vector collection return chunks in arbitrary order

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/retrieval/vector/dbs/pgvector.py:611-692`; `apps/server/local_llm/retrieval/utils.py:678-692`; `apps/server/local_llm/retrieval/utils.py:1603-1625`
- Root cause: No ordering.
- Recommended fix: Order by file id and `start_index`.
- Files likely to change: apps/server/local_llm/retrieval/vector/dbs/pgvector.py, apps/server/local_llm/retrieval/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: chunks come back in start_index order.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-231 [#357](https://github.com/epittman23/local-llm/issues/357): With enriched texts on, hybrid search returns the BM25 scoring text as the chunk content

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/utils.py:540-545`; `apps/server/local_llm/retrieval/utils.py:568-572`; `apps/server/local_llm/retrieval/utils.py:585-589`
- Root cause: Scoring text used as content.
- Recommended fix: Restore the original chunk text by hash before reranking.
- Files likely to change: apps/server/local_llm/retrieval/utils.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: chunks are plain with enrichment on.

#### A-232 [#358](https://github.com/epittman23/local-llm/issues/358): Notes shared through a readable folder are left out of RAG, unlike files and knowledge bases in the same folder

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/retrieval/utils.py:1392-1404`; `apps/server/local_llm/retrieval/utils.py:1448-1457`; `apps/server/local_llm/retrieval/utils.py:1497-1511`; `apps/server/local_llm/utils/access_control/files.py:17`
- Root cause: Inconsistent access rule.
- Recommended fix: Accept `('note', id)` in the folder items.
- Files likely to change: apps/server/local_llm/retrieval/utils.py, apps/server/local_llm/utils/access_control/files.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the folder note is included.

#### A-177 [#303](https://github.com/epittman23/local-llm/issues/303): Memory routes write the database before embedding, so a failed embedding leaves stale or missing memories in chat context

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/routers/memories.py:136-157`; `apps/server/local_llm/routers/memories.py:200-223`; `apps/server/local_llm/routers/memories.py:256-290`; `apps/server/local_llm/routers/memories.py:449-470`; `apps/server/local_llm/routers/memories.py:565-593`; `apps/server/local_llm/routers/memories.py:619-622`; `apps/server/local_llm/utils/memory.py:315-339`; `apps/server/local_llm/utils/memory.py:400-435`
- Root cause: DB and vector writes are not ordered or compensated, and context trusts vector text.
- Recommended fix: Embed before writing (or roll back), apply vector deletes regardless of upsert failures, reindex by building then swapping, and resolve vector hits against DB rows.
- Files likely to change: apps/server/local_llm/routers/memories.py, apps/server/local_llm/utils/memory.py
- Regression risks: Keep the embedding call off the event loop.
- Docs to update: None.
- Acceptance criteria: Tests for the add, update and reset failure paths.

### B23 Calendar, automations, channels and notes (final wave)

#### A-192 [#318](https://github.com/epittman23/local-llm/issues/318): Saving any occurrence of a repeating calendar event moves the whole series to start there; deleting an occurrence deletes the series

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/web/src/routes/calendar/CalendarPage.tsx:198-202`; `apps/web/src/routes/calendar/calendarModel.ts:150-163`; `apps/web/src/routes/calendar/calendarModel.ts:186-208`; `apps/web/src/routes/calendar/CalendarDialogs.tsx:69`; `apps/web/src/routes/calendar/CalendarDialogs.tsx:82-83`; `apps/web/src/routes/calendar/CalendarDialogs.tsx:101`; `apps/server/local_llm/utils/calendar.py:68-74`; `apps/server/local_llm/models/calendar.py:703-717`
- Root cause: Expanded instances are treated as the stored event.
- Recommended fix: When `instance_id` is set, load the parent and seed the form from it (or keep the parent's start); make Delete say it removes the series, or add per-occurrence exceptions.
- Files likely to change: apps/web/src/routes/calendar/CalendarPage.tsx, apps/web/src/routes/calendar/calendarModel.ts, apps/web/src/routes/calendar/CalendarDialogs.tsx, apps/server/local_llm/utils/calendar.py, apps/server/local_llm/models/calendar.py
- Regression risks: Editing the time of day of a series must still be possible.
- Docs to update: None.
- Acceptance criteria: Vitest: editing an occurrence sends the series' original start.

#### A-193 [#319](https://github.com/epittman23/local-llm/issues/319): Calendar day and week views show an event only in its starting hour, so multi-day and all-day events vanish on later days

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/calendar/CalendarViews.tsx:166`; `apps/web/src/routes/calendar/CalendarViews.tsx:202`; `apps/web/src/routes/calendar/calendarModel.ts:88-91`; `apps/server/local_llm/models/calendar.py:562-569`
- Root cause: Hour bucketing by start time only.
- Recommended fix: Add an all-day/continuing band per day using the overlap logic, and treat all-day separately.
- Files likely to change: apps/web/src/routes/calendar/CalendarViews.tsx, apps/web/src/routes/calendar/calendarModel.ts, apps/server/local_llm/models/calendar.py
- Regression risks: Do not duplicate events that start that day.
- Docs to update: None.
- Acceptance criteria: Vitest: the day view for Oct 20 shows both events.

#### A-194 [#320](https://github.com/epittman23/local-llm/issues/320): Clicking a channel automation's run in the calendar opens /c/channel:<id>, which bounces to a blank chat

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/calendar/calendarModel.ts:216-219`; `apps/web/src/routes/calendar/CalendarPage.tsx:198-200`; `apps/server/local_llm/utils/automations.py:484`; `apps/server/local_llm/routers/calendar.py:244-256`; `apps/web/src/routes/automations/automationModel.ts:192-193`
- Root cause: Missing channel mapping.
- Recommended fix: Use `runTarget` in `automationTarget` and test the channel case.
- Files likely to change: apps/web/src/routes/calendar/calendarModel.ts, apps/web/src/routes/calendar/CalendarPage.tsx, apps/server/local_llm/utils/automations.py, apps/server/local_llm/routers/calendar.py, apps/web/src/routes/automations/automationModel.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: the target is `/channels/ch1`.

#### A-195 [#321](https://github.com/epittman23/local-llm/issues/321): Calendar hour rows mis-bucket events on daylight-saving days: duplicated on spring-forward, missing on fall-back

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/calendar/calendarModel.ts:88-99`; `apps/web/src/routes/calendar/CalendarViews.tsx:189-207`
- Root cause: Fixed-length hours assumed.
- Recommended fix: Bound rows by consecutive local row starts and let the repeated hour include both instances.
- Files likely to change: apps/web/src/routes/calendar/calendarModel.ts, apps/web/src/routes/calendar/CalendarViews.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: each DST event appears exactly once.

#### A-196 [#322](https://github.com/epittman23/local-llm/issues/322): Clearing the time in the automation schedule picker sends BYMINUTE=undefined, or runs a one-time automation at midnight

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/automations/AutomationDialog.tsx:118-137`; `apps/web/src/routes/automations/automationModel.ts:64-74`; `apps/web/src/routes/automations/automationModel.ts:145-146`
- Root cause: Guard checks NaN but not missing parts.
- Recommended fix: Ignore empty or incomplete time values and reject empty Once date/time.
- Files likely to change: apps/web/src/routes/automations/AutomationDialog.tsx, apps/web/src/routes/automations/automationModel.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: clearing the time keeps the previous value or blocks save.

#### A-197 [#323](https://github.com/epittman23/local-llm/issues/323): Automation JSON import stops at the first rejected item, keeping earlier items and giving no count

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/automations/AutomationsPage.tsx:145-160`; `apps/web/src/lib/apis/automations/index.ts:108-135`; `apps/server/local_llm/routers/automations.py:217-223`
- Root cause: No per-item error handling.
- Recommended fix: Catch per item and report imported/failed counts; skip exhausted one-time rules.
- Files likely to change: apps/web/src/routes/automations/AutomationsPage.tsx, apps/web/src/lib/apis/automations/index.ts, apps/server/local_llm/routers/automations.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: a failing item does not stop the rest.

#### A-198 [#324](https://github.com/epittman23/local-llm/issues/324): Calendar display details: unknown reminder values show as None, month cells are not in time order, paused automations show a next run, and the user timezone is synced only at sign-in

- Severity / status / effort: Low / Confirmed / M
- Locations: `apps/web/src/routes/calendar/CalendarDialogs.tsx:23-31`; `apps/web/src/routes/calendar/CalendarDialogs.tsx:226-237`; `apps/server/local_llm/routers/calendar.py:186-268`; `apps/web/src/routes/calendar/calendarModel.ts:77-85`; `apps/web/src/routes/automations/AutomationPage.tsx:183`; `apps/server/local_llm/routers/automations.py:146-153`; `apps/web/src/routes/public/AuthPage.tsx:74-77`; `apps/web/src/lib/auth/session.ts`
- Root cause: Several small display and sync gaps in the port.
- Recommended fix: Add an option for the current reminder value; sort by start; show "Not scheduled" when paused; sync the timezone in `initAuth`.
- Files likely to change: apps/web/src/routes/calendar/CalendarDialogs.tsx, apps/server/local_llm/routers/calendar.py, apps/web/src/routes/calendar/calendarModel.ts, apps/web/src/routes/automations/AutomationPage.tsx, apps/server/local_llm/routers/automations.py, apps/web/src/routes/public/AuthPage.tsx, apps/web/src/lib/auth/session.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest for each case.

#### A-199 [#325](https://github.com/epittman23/local-llm/issues/325): 207 emoji shortcodes (heart, warning, v, point_up, check marks) produce text-style characters without the emoji variation selector

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/emoji/emoji.ts:89`; `apps/web/src/lib/emoji/emoji.ts:97-107`
- Root cause: Shortcode data uses bare code points.
- Recommended fix: Build `char` from the FE0F form when the group list contains it.
- Files likely to change: apps/web/src/lib/emoji/emoji.ts
- Regression risks: Stored reactions keyed by the old character need matching.
- Docs to update: None.
- Acceptance criteria: Vitest: heart resolves to U+2764 U+FE0F.

#### A-200 [#326](https://github.com/epittman23/local-llm/issues/326): {{USER_LANGUAGE}} is always en-US, and the stored locale is overwritten

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/i18n/index.ts:24-29`; `apps/web/src/lib/chat/request.ts:17-20`; `apps/web/src/lib/chat/request.ts:32`
- Root cause: A side effect of removing locales.
- Recommended fix: Derive USER_LANGUAGE from `navigator.language`, or drop `supportedLngs`.
- Files likely to change: apps/web/src/lib/i18n/index.ts, apps/web/src/lib/chat/request.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: a de-DE browser yields de-DE.

#### A-201 [#327](https://github.com/epittman23/local-llm/issues/327): Direct-message and group channel messages never send channel.message notifications

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/routers/channels.py:81-89`; `apps/server/local_llm/routers/channels.py:943-950`; `apps/server/local_llm/models/access_grants.py:701-718`; `apps/server/local_llm/models/channels.py:373`; `apps/server/local_llm/routers/channels.py:261-269`; `apps/web/src/routes/channels/channelModel.ts:461`
- Root cause: Recipient resolution assumes grant-based membership.
- Recommended fix: Use active channel members as recipients for dm and group channels.
- Files likely to change: apps/server/local_llm/routers/channels.py, apps/server/local_llm/models/access_grants.py, apps/server/local_llm/models/channels.py, apps/web/src/routes/channels/channelModel.ts
- Regression risks: Do not notify the sender.
- Docs to update: None.
- Acceptance criteria: Test: a DM message notifies the other member.

#### A-202 [#328](https://github.com/epittman23/local-llm/issues/328): In channel (inline) response mode the model gets no conversation context, not even the message being replied to

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/channels.py:983-989`; `apps/server/local_llm/routers/channels.py:1006-1019`; `apps/server/local_llm/routers/channels.py:1047-1058`; `apps/server/local_llm/routers/channels.py:1087`; `apps/server/local_llm/models/messages.py:317-343`
- Root cause: History selection assumes thread mode.
- Recommended fix: Build channel-mode history from recent top-level messages or the reply chain; drop the trigger from history; skip empty/unfinished model messages; always include the thread root.
- Files likely to change: apps/server/local_llm/routers/channels.py, apps/server/local_llm/models/messages.py
- Regression risks: Bound the history size.
- Docs to update: None.
- Acceptance criteria: Test: channel-mode history includes the replied-to message.

#### A-203 [#329](https://github.com/epittman23/local-llm/issues/329): A channel model reply stays on "Thinking" forever when the completion fails before its task starts or ends with no text

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/channels.py:1021-1037`; `apps/server/local_llm/routers/channels.py:1139-1142`; `apps/server/local_llm/main.py:1062-1074`; `apps/server/local_llm/main.py:1846-1851`; `apps/server/local_llm/socket/main.py:999-1004`; `apps/web/src/routes/channels/ChannelMessageView.tsx:325-326`
- Root cause: No error path for the placeholder; the view ignores done.
- Recommended fix: On failure after the placeholder exists, write an error with `meta.done` and emit an update; show the skeleton only while not done.
- Files likely to change: apps/server/local_llm/routers/channels.py, apps/server/local_llm/main.py, apps/server/local_llm/socket/main.py, apps/web/src/routes/channels/ChannelMessageView.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a failing completion leaves an error message, not a spinner.

#### A-204 [#330](https://github.com/epittman23/local-llm/issues/330): Pinning a webhook message relabels it as the webhook owner, and the pinned list names every webhook "Webhook"

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/channels.py:1399-1421`; `apps/server/local_llm/routers/channels.py:909-915`; `apps/server/local_llm/routers/channels.py:2015`; `apps/server/local_llm/routers/channels.py:1315-1321`; `apps/server/local_llm/models/messages.py:194-214`
- Root cause: Author re-resolved by user id.
- Recommended fix: Reuse the resolved `message.user` and resolve webhook names in the pinned list.
- Files likely to change: apps/server/local_llm/routers/channels.py, apps/server/local_llm/models/messages.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: pinning keeps the webhook author.

#### A-205 [#331](https://github.com/epittman23/local-llm/issues/331): A group channel's Public setting is saved but never enforced

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/channels/ChannelDialogs.tsx:689-703`; `apps/web/src/routes/channels/channelModel.ts:460`; `apps/server/local_llm/models/channels.py:836`; `apps/server/local_llm/models/channels.py:395-405`
- Root cause: Field stored but unused.
- Recommended fix: Implement public group listing and join-on-open, or remove the option.
- Files likely to change: apps/web/src/routes/channels/ChannelDialogs.tsx, apps/web/src/routes/channels/channelModel.ts, apps/server/local_llm/models/channels.py
- Regression risks: Implementing it changes visibility; ask the owner.
- Docs to update: None.
- Acceptance criteria: Test or removal of the option.

#### A-206 [#332](https://github.com/epittman23/local-llm/issues/332): Note delete reports success when it failed, and a failed pin returns 500

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/notes.py:701-703`; `apps/server/local_llm/routers/notes.py:750-758`; `apps/server/local_llm/models/notes.py:370-393`; `apps/server/local_llm/models/notes.py:419-428`
- Root cause: Return values ignored.
- Recommended fix: Check results and return 400.
- Files likely to change: apps/server/local_llm/routers/notes.py, apps/server/local_llm/models/notes.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Tests with injected failures.

#### A-207 [#333](https://github.com/epittman23/local-llm/issues/333): Deleting a channel leaves its messages, reactions, memberships and webhooks; deleting a note leaves its chats

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/models/channels.py:907-912`; `apps/server/local_llm/models/channels.py:160`; `apps/server/local_llm/models/notes.py:419-428`; `apps/server/local_llm/routers/notes.py:364-388`; `apps/server/local_llm/routers/notes.py:488-512`
- Root cause: No cascades and no cleanup.
- Recommended fix: Delete dependents in the same transaction.
- Files likely to change: apps/server/local_llm/models/channels.py, apps/server/local_llm/models/notes.py, apps/server/local_llm/routers/notes.py
- Regression risks: Large channels: delete in bulk statements.
- Docs to update: None.
- Acceptance criteria: Test: no rows reference a deleted channel or note.

#### A-230 [#356](https://github.com/epittman23/local-llm/issues/356): The Scheduled Tasks calendar shows runs that will never happen for COUNT rules

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/calendar.py:209-235`; `apps/server/local_llm/utils/calendar.py:46-52`
- Root cause: Different rule parsing in two places.
- Recommended fix: Expand automation rules with the scheduler's own parsing (stored DTSTART), from max(start, now).
- Files likely to change: apps/server/local_llm/routers/calendar.py, apps/server/local_llm/utils/calendar.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the calendar shows the scheduler's remaining runs.

### B24 Sharing, workspace, admin integrations and plugins (final wave)

#### A-208 [#334](https://github.com/epittman23/local-llm/issues/334): Share links open only for the owner and admins: the React share dialog lost the access-control panel

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/chat/sidebar/ChatDialogs.tsx:38-90`; `apps/web/src/lib/apis/chats/index.ts:1194`; `apps/web/src/lib/apis/chats/index.ts:1229`; `apps/server/local_llm/routers/chats.py:1632-1676`; `apps/server/local_llm/routers/chats.py:907-923`; `apps/server/local_llm/routers/chats.py:110-123`
- Root cause: Port regression, undocumented.
- Recommended fix: Port the AccessControl panel (read-only roles, public/open sharing permissions); coordinate with B0 (see the advisories).
- Files likely to change: apps/web/src/routes/chat/sidebar/ChatDialogs.tsx, apps/web/src/lib/apis/chats/index.ts, apps/server/local_llm/routers/chats.py
- Regression risks: Coordinate with B0; see the advisories.
- Docs to update: None.
- Acceptance criteria: e2e with the real response shapes: adding a grant lets another user open the share.

#### A-209 [#335](https://github.com/epittman23/local-llm/issues/335): Saving a model, prompt or skill as a non-admin strips existing public, user or group grants

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/models.py:824-832`; `apps/server/local_llm/routers/prompts.py:290-299`; `apps/server/local_llm/routers/skills.py:310-323`; `apps/server/local_llm/routers/models.py:904-912`; `apps/server/local_llm/routers/prompts.py:470-478`; `apps/server/local_llm/routers/skills.py:388-396`; `apps/server/local_llm/utils/access_control/__init__.py:221-300`; `apps/server/local_llm/models/access_grants.py:442-458`; `apps/web/src/routes/workspace/models/modelEditorLogic.ts:188`
- Root cause: The add-time filter is applied to the whole replacement list.
- Recommended fix: Filter only grants being added (submitted minus stored) and keep the stored ones.
- Files likely to change: apps/server/local_llm/routers/models.py, apps/server/local_llm/routers/prompts.py, apps/server/local_llm/routers/skills.py, apps/server/local_llm/utils/access_control/__init__.py, apps/server/local_llm/models/access_grants.py, apps/web/src/routes/workspace/models/modelEditorLogic.ts
- Regression risks: Must still block unauthorized additions.
- Docs to update: None.
- Acceptance criteria: Test: a co-editor save keeps an existing public grant.

#### A-210 [#336](https://github.com/epittman23/local-llm/issues/336): Cloning or sharing a chat while a reply streams copies the unfinished placeholder (fork is guarded, clone and share are not)

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/chats.py:1462-1513`; `apps/server/local_llm/routers/chats.py:1521-1588`; `apps/server/local_llm/routers/chats.py:1385-1401`; `apps/server/local_llm/main.py:1210-1220`; `apps/web/src/routes/chat/useChatSession.ts:181-186`
- Root cause: Guard implemented only for fork.
- Recommended fix: Apply fork's active-task and unfinished-assistant checks to clone, clone-of-share and share.
- Files likely to change: apps/server/local_llm/routers/chats.py, apps/server/local_llm/main.py, apps/web/src/routes/chat/useChatSession.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: clone during an active task returns 409.

#### A-211 [#337](https://github.com/epittman23/local-llm/issues/337): POST /models/import reports success when entries were skipped or failed to save

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/models.py:418-541`; `apps/server/local_llm/models/models.py:212-235`; `apps/server/local_llm/models/models.py:543-558`; `apps/web/src/routes/admin/settings/models/AdminModels.tsx:373`
- Root cause: Results ignored.
- Recommended fix: Return per-entry results and show counts.
- Files likely to change: apps/server/local_llm/routers/models.py, apps/server/local_llm/models/models.py, apps/web/src/routes/admin/settings/models/AdminModels.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: a failing entry is reported.

#### A-212 [#338](https://github.com/epittman23/local-llm/issues/338): Deleting another user's chat as an admin runs orphan-tag cleanup against the admin's own tags

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/chats.py:1295`; `apps/server/local_llm/models/chats.py:2376-2396`
- Root cause: Wrong user id.
- Recommended fix: Use `chat.user_id`.
- Files likely to change: apps/server/local_llm/routers/chats.py, apps/server/local_llm/models/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the owner's tags are cleaned, the admin's are kept.

#### A-213 [#339](https://github.com/epittman23/local-llm/issues/339): Chat search snippets can miss the match when the text contains characters that lengthen when lowercased

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/chats.py:175-209`
- Root cause: Index mismatch between lowered and original text.
- Recommended fix: Search case-insensitively on the original string.
- Files likely to change: apps/server/local_llm/routers/chats.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the repro snippet contains the match.

#### A-214 [#340](https://github.com/epittman23/local-llm/issues/340): A model downloaded by URL is hashed and pushed to Ollama before its last bytes are flushed, so a truncated blob is reported as done

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/routers/ollama.py:1576-1607`
- Root cause: Post-processing inside the writer context.
- Recommended fix: Close the file before hashing and pushing; verify the byte count against Content-Length.
- Files likely to change: apps/server/local_llm/routers/ollama.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: the pushed blob equals the source.

#### A-215 [#341](https://github.com/epittman23/local-llm/issues/341): URL model downloads ignore the HTTP status, resume blindly, and are capped at 10 minutes (30 s for the push)

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/routers/ollama.py:1564-1583`; `apps/server/local_llm/routers/ollama.py:1572`; `apps/server/local_llm/routers/ollama.py:1601`; `apps/server/local_llm/routers/ollama.py:1626-1634`
- Root cause: Unchecked responses and whole-request timeouts.
- Recommended fix: Require 200 or a matching 206, handle 416 as complete, key partial files by URL, and use idle timeouts instead of total caps.
- Files likely to change: apps/server/local_llm/routers/ollama.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Tests for each repro case.

#### A-216 [#342](https://github.com/epittman23/local-llm/issues/342): Saving Admin > Audio with local Whisper fails after persisting whenever the model cannot load, and the page shows nothing

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/audio.py:211-230`; `apps/server/local_llm/routers/audio.py:284-296`; `apps/web/src/lib/apis/audio/index.ts:43-51`; `apps/web/src/routes/admin/settings/Audio.tsx:113-129`
- Root cause: Unconditional synchronous model reload after persisting.
- Recommended fix: Load the model only when the STT engine/model changed (in the background or before persisting) and return a JSON error.
- Files likely to change: apps/server/local_llm/routers/audio.py, apps/web/src/lib/apis/audio/index.ts, apps/web/src/routes/admin/settings/Audio.tsx
- Regression risks: Keep the event loop free during model load.
- Docs to update: docs/guides/dependencies.md (where the Whisper model must be cached for offline mode).
- Acceptance criteria: Router test: a TTS-only save does not load Whisper.

#### A-217 [#343](https://github.com/epittman23/local-llm/issues/343): With the "Web API" speech-to-text engine selected, every uploaded audio file fails processing with a TypeError

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/audio.py:906-916`; `apps/server/local_llm/routers/audio.py:1113`; `apps/server/local_llm/routers/files.py:150-162`; `apps/web/src/routes/admin/settings/Audio.tsx:225`
- Root cause: Missing engine branch.
- Recommended fix: Skip server transcription for browser-side engines and store the file with a clear status.
- Files likely to change: apps/server/local_llm/routers/audio.py, apps/server/local_llm/routers/files.py, apps/web/src/routes/admin/settings/Audio.tsx
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Test: a web-engine upload is stored without error.

#### A-218 [#344](https://github.com/epittman23/local-llm/issues/344): A malformed image edit size is accepted on save and then makes every image edit fail

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/images.py:275-296`; `apps/server/local_llm/routers/images.py:861-867`; `apps/server/local_llm/routers/images.py:1093`
- Root cause: Missing validation.
- Recommended fix: Validate with the same pattern as `IMAGE_SIZE`, or skip unparsable values.
- Files likely to change: apps/server/local_llm/routers/images.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Router test: an invalid edit size is rejected.

#### A-219 [#345](https://github.com/epittman23/local-llm/issues/345): Ollama API proxy routes: prefixed model ids are sent unstripped, an inverted message validator rejects tool-call turns, and failed uploads leave multi-GB files

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/ollama.py:433-455`; `apps/server/local_llm/routers/ollama.py:703-710`; `apps/server/local_llm/routers/ollama.py:775-780`; `apps/server/local_llm/routers/ollama.py:817-823`; `apps/server/local_llm/routers/ollama.py:860-865`; `apps/server/local_llm/routers/ollama.py:1029-1043`; `apps/server/local_llm/routers/ollama.py:1655-1726`
- Root cause: Three independent proxy-route defects with one owner (the Ollama proxy).
- Recommended fix: Strip the provider prefix before sending; use an after-model validator; clean up in `finally`.
- Files likely to change: apps/server/local_llm/routers/ollama.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Tests for each case.

#### A-170 [#296](https://github.com/epittman23/local-llm/issues/296): Admin password reset for a SCIM-created user silently does nothing but reports success

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/scim.py:614-621`; `apps/server/local_llm/routers/users.py:969`; `apps/server/local_llm/routers/users.py:1015-1023`
- Root cause: SCIM create bypasses `Auths.insert_new_auth` and the result of the write is ignored.
- Recommended fix: Create the Auth row in SCIM create, and return an error when the password write affects no row.
- Files likely to change: apps/server/local_llm/routers/scim.py, apps/server/local_llm/routers/users.py
- Regression risks: Existing SCIM users without Auth rows need a migration or on-demand creation.
- Docs to update: None.
- Acceptance criteria: Router test: resetting a SCIM user's password either works or returns an error.

#### A-176 [#302](https://github.com/epittman23/local-llm/issues/302): A function edit whose code fails to load switches off the live function while the API reports the update was rejected

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/routers/functions.py:391-428`; `apps/server/local_llm/routers/functions.py:167-196`; `apps/server/local_llm/utils/plugin.py:352-358`
- Root cause: One loader serves both runtime loads (deactivation intended) and validation of candidate code.
- Recommended fix: Add a validate-only mode used by create/update/sync; deactivate only on runtime load failures of stored code.
- Files likely to change: apps/server/local_llm/routers/functions.py, apps/server/local_llm/utils/plugin.py
- Regression risks: Runtime failures of stored code must still deactivate.
- Docs to update: None.
- Acceptance criteria: Router test: a rejected update makes no DB write.

#### A-178 [#304](https://github.com/epittman23/local-llm/issues/304): The Pipelines server's error details never reach the client, and valve reads publish a valves-updated event while updates publish none

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/routers/pipelines.py:92-117`; `apps/server/local_llm/routers/pipelines.py:158-183`; `apps/server/local_llm/routers/pipelines.py:283-570`; `apps/server/local_llm/routers/pipelines.py:463-469`; `apps/server/local_llm/routers/pipelines.py:530-552`
- Root cause: Body read after release; event published from the wrong handler.
- Recommended fix: Parse the body inside the `async with`; move the publish to the update handler.
- Files likely to change: apps/server/local_llm/routers/pipelines.py
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Tests for both repro cases.

#### A-179 [#305](https://github.com/epittman23/local-llm/issues/305): Task prompt templates re-expand template variables inside the user's own messages

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/server/local_llm/utils/task.py:331-389`; `apps/server/local_llm/routers/tasks.py:177`; `apps/server/local_llm/routers/tasks.py:245`; `apps/server/local_llm/routers/tasks.py:446`
- Root cause: Template expansion runs after user content is inserted.
- Recommended fix: Substitute static variables in the template first and insert user content last.
- Files likely to change: apps/server/local_llm/utils/task.py, apps/server/local_llm/routers/tasks.py
- Regression risks: Admin templates that rely on current ordering.
- Docs to update: None.
- Acceptance criteria: Test: user text with template syntax is kept literal.

#### A-180 [#306](https://github.com/epittman23/local-llm/issues/306): generateTags turns every apostrophe into a double quote before parsing, so one tag with an apostrophe empties the list

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/apis/index.ts:853-879`; `apps/web/src/routes/chat/useChatSession.ts:675`
- Root cause: Unconditional quote normalisation.
- Recommended fix: Try `JSON.parse` on the raw block first; normalise quotes only as a fallback.
- Files likely to change: apps/web/src/lib/apis/index.ts, apps/web/src/routes/chat/useChatSession.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: Vitest: the apostrophe case returns both tags.

## 5. Rules for the fixing session (from AGENTS.md)

- One branch and one pull request per batch; `main` takes squash-merged PRs
  after the required `CI passed` check.
- Conventional commits, one topic each (for example
  `fix(benchmarks): require the grading sentinel before scoring a pass`).
- Run `make check` (or each of its parts, as above) and get it green before
  opening a PR.
- A regression test for every fix, failing before and passing after; name it in
  the PR. Playwright mocks the backend, so a fix across the seam (B4, B6) also
  needs a backend test of the real response shape.
- Update the docs in the same commit as the code, per the maintenance policy
  (README, AGENTS.md "Local inference", `docs/guides/*`, MAP.md as applicable).
- Add a dated entry at the top of `docs/decisions.md` (never edit older
  entries) when a fix changes a decision, and the matching milestone in
  `docs/roadmap-timeline.mmd` plus the byte-identical block in `docs/ROADMAP.md`.
  Likely for B1 (meaning of stored pass rates), B2 and B3.
- Schema changes are new Alembic revisions under
  `apps/server/local_llm/migrations/versions/`; never edit an applied one.
- When fingerprint coverage changes (B3), add a `benchmark_schema_note` row in
  the same change and mirror the flags in `serving/fingerprint.py`.
- Never reformat files under `apps/server/local_llm/benchmarks/data/prompts/`.
- No co-author lines and no "Generated with Claude Code" text in commits or PRs.
- Stop and ask the owner before changing a public interface (API routes or
  response shapes beyond what the issue describes) or making an architectural
  decision; section 6 records the decisions already made.
- Reference the issue in each PR (`Fixes #N`) and do not touch issues outside
  the batch.

## 6. Owner decisions (2026-10-19)

The owner answered the audit's open questions on 2026-10-19. Context for all
of them: the database held no benchmark data that day, and the owner plans to
re-test everything once the fixes land.

1. **A-02 fingerprint ([#127](https://github.com/epittman23/local-llm/issues/127))**: take the best fix, even though every
   `config_id` changes. See A-02 in section 4 (model basename and `extra`
   lines, always present; a `benchmark_schema_note` row still required).
2. **A-16 dataset fetch and selfcheck ([#141](https://github.com/epittman23/local-llm/issues/141))**: build the endpoints and Tests
   page actions properly; do not settle for a docs-only fix.
3. **A-01 grader ([#126](https://github.com/epittman23/local-llm/issues/126))**: do not re-grade stored answers.
4. **A-09 tuning verdicts ([#134](https://github.com/epittman23/local-llm/issues/134))**: do not review past `adopted` sweeps.
5. **A-21 ([#146](https://github.com/epittman23/local-llm/issues/146))**: run `make test-e2e` with `CI=1`.
6. **Security findings**: filed as private draft security advisories, to be
   fixed first (batch B0), before any bug-fix batch.

### Still open at execution time

- **Scope of the "Interface Settings Access" permission** (gap finding in B18,
  "Personal settings switches fail silently ..."): the backend uses it to gate
  every personal settings write, while the UI hides only the Interface tab.
  Decide whether it covers all personal settings (hide every tab) or only the
  interface keys (narrow the backend check).
- **Where to fix B0.** A normal pull request in this public repository
  discloses the vulnerability before the advisory is published. GitHub's
  temporary private fork (an advisory's "Start a temporary private fork")
  avoids that, but check before relying on it that GitHub Actions run there
  and that the required `CI passed` check is satisfied; if not, run
  `make check` locally and ask the owner how to merge. Many B0 fixes are
  small, so the window a public PR opens is short; the owner chooses.
