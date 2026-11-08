# Features and the model harness

An overview of what a user can do in the app, how a chat message reaches
a model, and how the benchmark harness scores the assistant as deployed.
It is written from `main` at `3093ffb1` (2026-11-08). It summarises and
links; the details live in the guides it points to, and every page and URL
is listed in [README.md's Pages and URLs](../../README.md#pages-and-urls).

The diagrams are Mermaid. Each `.mmd` file beside this one is the canonical
source, and the fenced copy here is byte-identical to it, the same
arrangement as [ROADMAP.md](../ROADMAP.md) and `roadmap-timeline.mmd`. Edit
the `.mmd` file, then paste it here unchanged.

## Feature map

Canonical source: [`features-map.mmd`](features-map.mmd).

```mermaid
flowchart LR
  user(["Signed-in user"])
  admin(["Admin"])

  subgraph CHAT["Chat: / and /c/id and /folders/id"]
    direction TB
    chatPick["Model picker and @ mention: one Workspace model entry per task"]
    chatAttach["Attach files, knowledge bases, a URL or a YouTube video"]
    chatTools["Per-chat toggles: web search, image generation, code interpreter"]
    chatOrg["Folders, pins, archive, temporary chat"]
    chatShare["Share links: read-only /s/share-id"]
  end

  subgraph WORK["Workspace: /workspace"]
    direction TB
    wsModels["Models: entry = base model + system prompt + params + tools + knowledge"]
    wsKnow["Knowledge: file trees on pgvector, hybrid search + reranker"]
    wsPrompts["Prompts: saved prompts with version history"]
    wsSkills["Skills: instructions a model can load"]
    wsTools["Tools: Python tool code (plugins on only)"]
  end

  subgraph PERSONAL["Productivity, each behind a feature flag"]
    direction TB
    notes["Notes /notes: TipTap editor, autosave"]
    cal["Calendar /calendar: month, week, day"]
    auto["Automations /automations: scheduled prompts and their runs"]
    chan["Channels /channels/id: live messages, threads, members"]
  end

  subgraph SETTINGS["Settings modal: ?settings=tab"]
    direction TB
    setUser["Personal: interface, audio, connections, personalization, data, account"]
    setAdmin["Admin tabs: connections, models, documents, web, code execution, images, subagents"]
  end

  subgraph ADMIN["Admin pages: /admin"]
    direction TB
    users["Users and groups, permissions"]
    evals["Evaluations: leaderboard and feedback"]
    funcs["Functions: filters and pipes (plugins on only)"]
    play["Playground: chat, completions, images"]
  end

  subgraph BENCH["Benchmarks: /benchmarks, admin + enable_benchmarks"]
    direction TB
    bServe["Serve: start llama-server from a profile"]
    bLive["Live: GPU telemetry"]
    bTests["Tests: graded coding items, bare, or through the harness (API only)"]
    bCompare["Compare, Answers, Report"]
    bTune["Tune and Pre-screen: search serving flags"]
  end

  user --> CHAT
  user --> WORK
  user --> PERSONAL
  user --> SETTINGS
  admin --> ADMIN
  admin --> BENCH
  admin --> setAdmin

  wsModels -. "picked in" .-> chatPick
  wsKnow -. "attached with #" .-> chatAttach
  wsPrompts -. "inserted with /" .-> chatPick
  wsSkills -. "set on an entry" .-> wsModels
  bServe -. "same OpenAI API on :8090" .-> setAdmin
  wsModels -. "harness_model" .-> bTests
```

### Chat

The page at `/` (a saved chat at `/c/<id>`, a new chat in a folder at
`/folders/<id>`).

- **Models.** The picker, or `@` in the input, chooses a Workspace model
  entry. Each entry wraps one connection model with its own system prompt
  and params; the entries in use are in
  [README.md's Model setup](../../README.md#model-setup).
- **Context.** Upload files, attach a knowledge base with `#`, insert a
  saved prompt with `/`, or open a chat with `?load-url=` or `?youtube=`.
- **Tools.** Per-chat toggles for web search, image generation and the code
  interpreter. With native function calling (the default) they are tools
  the model chooses to call; see
  [How a chat reaches a model](#how-a-chat-reaches-a-model).
- **Organising.** Folders, pins, archive, temporary chats
  (`?temporary-chat=true`, nothing saved) and read-only share links at
  `/s/<share-id>`.
- **Memory.** With memory on, saved memories are added to the system
  context. The background review that writes memories every tenth turn is
  configured but has not yet been seen working end to end
  ([assistant-tools.md](assistant-tools.md#memory-background-review)).

### Workspace (`/workspace`)

Each section needs its permission; an admin sees all of them.

| Section | What it holds |
|---|---|
| Models | Model entries: base model, system prompt, params, default tools, skills, knowledge, capabilities |
| Knowledge | Knowledge bases as file trees with uploads and folder sync, embedded with `BAAI/bge-m3` and searched hybrid (BM25 + vector) with a reranker ([assistant-tools.md](assistant-tools.md#knowledge-retrieval)) |
| Prompts | Saved prompts with version history |
| Skills | Instructions a model entry carries, loaded by the model when it needs them |
| Tools | Python tool code; hidden when the backend has plugins off |

### Notes, calendar, automations, channels

Each is behind a feature flag (`enable_notes`, `enable_calendar`,
`enable_automations`, `enable_channels`) and, for a non-admin, a
permission.

| Page | What it does |
|---|---|
| `/notes` | A TipTap editor with autosave; a chat about a note sees the note |
| `/calendar` | Month, week and day views; event alerts come from the backend's scheduler |
| `/automations` | Prompts run on a schedule (an RRULE), with each run listed |
| `/channels/<id>` | Live messages, threads, reactions, pins and members |

The assistant can also reach these through its builtin tools (search
notes, create an automation, look up calendar events, and so on).

### Settings

Settings is a modal, opened from any page with `?settings=<tab>`.
Personal tabs cover the interface, audio, notifications, connections,
integrations, personalization, data controls, archived chats and the
account. An admin also gets `?settings=admin:<tab>`, where the app is
configured: connections, models, documents (retrieval), web search, code
execution, images, audio, subagents, analytics and more. The full tab list
is in [README.md](../../README.md#signed-in).

### Admin pages (`/admin`)

| Page | What it does |
|---|---|
| Users | Users and groups, their permissions, CSV import |
| Evaluations | The leaderboard built from chat ratings, and the feedback table with export |
| Functions | Filters and pipes that run inside the chat pipeline; plugins on only |
| Playground | Chat, completions and image generation against any model, outside a saved chat |

### Benchmarks (`/benchmarks`)

Admin only, and only while `enable_benchmarks` is not `false`. It is where
local inference is evaluated; chat stays on OpenRouter until local
throughput is acceptable.

| Page | What it does |
|---|---|
| Serve | Starts `llama-server` from a serving profile on `:8090`, with GPU telemetry recording |
| Live | The run being recorded, refreshed every 5 s |
| Tests | Graded items from HumanEval+, MBPP+, DS-1000 and LiveCodeBench, sent bare or through the harness (below) |
| Compare, Answers, Report | Pass rate and passes per minute by configuration, the stored answers, and the statistical report |
| Tune, Pre-screen | Search serving flags: a served round-elimination sweep, and a llama-bench Optuna study |

Details: [benchmarks.md](benchmarks.md), [llama-cpp.md](llama-cpp.md),
[telemetry.md](telemetry.md).

### Desktop app

The Electron app loads the same pages from the server, so it has every
feature above and none of its own; it starts and stops the stack when
nothing is running. See [desktop.md](desktop.md).

## How a chat reaches a model

Canonical source: [`features-chat-pipeline.mmd`](features-chat-pipeline.mmd).

```mermaid
flowchart TB
  page["Browser or desktop app: chat page"]
  api["POST /api/chat/completions: main.py chat_completion"]
  entry["Workspace model entry: base model id, system prompt, params, tools, skills, knowledge"]

  subgraph PAYLOAD["utils/middleware.py process_chat_payload"]
    direction TB
    p1["Arena pick, params, system prompt, history compaction"]
    p2["Folder context, inlet filters (plugins)"]
    p3["Features: voice prompt, memory context, code interpreter prompt"]
    p4["Skills applied, mention tags stripped"]
    p5["Tools resolved: builtin + workspace tools + MCP + terminal"]
    p6["File and knowledge context (RAG) put into the messages"]
    p1 --> p2 --> p3 --> p4 --> p5 --> p6
  end

  gen["utils/chat.py generate_chat_completion"]

  subgraph CONN["OpenAI-compatible connection, set in Admin Settings > Connections"]
    direction LR
    orr["OpenRouter: the default"]
    llama["llama-server on :8090: evaluation only"]
  end

  resp["process_chat_response: stream deltas to the page over the socket"]
  toolCall{"Structured tool call in the reply?"}

  subgraph TOOLS["Builtin tools, run on the server"]
    direction TB
    tCode["execute_code: Jupyter kernel, chat files copied in"]
    tWeb["search_web, fetch_url: SearXNG"]
    tKnow["knowledge and chat-file search: pgvector + reranker"]
    tMem["memory, notes, chats, channels, calendar, automations"]
    tImg["generate_image, edit_image"]
  end

  done["Final message saved to the chat, citations and files attached"]

  page --> api
  entry --> api
  api --> PAYLOAD
  PAYLOAD --> gen
  gen --> CONN
  CONN --> resp
  resp --> toolCall
  toolCall -- "yes, up to the tool-round cap" --> TOOLS
  TOOLS -- "tool result appended, next round" --> gen
  toolCall -- "no" --> done
```

- **One path for every model.** A chat names a Workspace model entry; the
  backend merges the entry's system prompt and params into the request and
  sends it to whichever OpenAI-compatible connection serves the entry's
  base model. OpenRouter is that connection today. Pointing chat at local
  inference is a change to the connection's base URL and API key in Admin
  Settings > Connections, nothing more.
- **Preparation** happens in `process_chat_payload`
  (`apps/server/local_llm/utils/middleware.py`): the system prompt, history
  compaction, inlet filters, memory context, skills, the tool list, and
  retrieved file and knowledge context.
- **Native function calling** is the default: web search, image generation,
  knowledge search and code execution are offered as builtin tools, and the
  model decides when to call them. The reply streams back to the page;
  each structured tool call runs on the server and its result goes back to
  the model for another round, up to `CHAT_RESPONSE_MAX_TOOL_CALL_ITERATIONS`
  (256 by default). Builtin tools are offered only to requests from the UI
  (they carry a socket session); a plain API caller gets only the tools it
  names.
- **Legacy function calling** (a per-model setting) instead runs web search
  and image generation up front, and lets a task model pick tool calls
  before the main request.
- **The code interpreter** runs on the Jupyter engine (`127.0.0.1:8888`), in
  a fresh kernel per block with the chat's uploaded files copied in. The
  inherited Pyodide engine does not work in this app.
  [assistant-tools.md](assistant-tools.md) covers Jupyter's sandbox,
  SearXNG and the retrieval models.

## The model harness

Canonical source: [`features-harness.mmd`](features-harness.mmd).

```mermaid
sequenceDiagram
  autonumber
  participant T as Tests run (API only)
  participant R as runner.py
  participant H as harness.py
  participant P as Chat pipeline
  participant G as upstream_trace guard
  participant L as llama-server :8090
  participant J as Jupyter :8888
  participant DB as Postgres

  T->>R: tier run or one item, with harness_model
  alt no harness_model (bare mode)
    R->>L: item straight to /v1/chat/completions
    L-->>R: answer and llama.cpp timings
  else harness_model set
    R->>H: prepare(model entry, port)
    H->>J: liveness check
    H-->>R: HarnessRefused if the entry is not served by this llama-server, streams off, legacy calling, max_completion_tokens, or Jupyter down
    R->>H: ask(item prompt)
    H->>P: process_chat_payload with a temporary chat id and native calling
    P-->>H: tools offered
    H->>P: tools cut to execute_code only, then generate_chat_completion
    loop at most 8 tool rounds, driven by process_chat_response
      P->>G: upstream request
      G->>L: sent only if its host is 127.0.0.1 on the served port
      L-->>P: streamed reply, maybe an execute_code call
      P->>J: execute_code runs the block in a fresh kernel
      J-->>P: stdout, stderr, result
    end
    P-->>H: assistant message
    H-->>R: text after the last code run, full output, harness_stats
    R->>R: spec read from the first upstream request, its sha is harness_sha
    R-->>T: run stops if the spec changes between items
  end
  R->>R: grade with the dataset's own tests
  R->>DB: benchmark_result and benchmark_answer, plus benchmark_harness for the sha
```

A Tests run measures either the bare model or the assistant as deployed.

- **Bare mode** (the default). Each item goes straight to `llama-server`'s
  `/v1/chat/completions`, optionally behind one of the system prompts in
  `benchmarks/data/prompts/`. It measures the model.
- **Harness mode.** With `harness_model` set to a Workspace model entry,
  `benchmarks/evaluation/harness.py` sends each item through the chat
  pipeline above: the entry's system prompt and params, native function
  calling, and the code interpreter on Jupyter. It uses a `temporary:` chat
  id, so no chat, title or memory is written, and it cuts the tools offered
  to `execute_code` alone. It measures the assistant.

What keeps a harness result trustworthy:

- **It refuses before it starts** when the entry is not served by the
  `llama-server` being measured, its base model is missing, it turns
  streaming off, uses legacy function calling or sets
  `max_completion_tokens`, or Jupyter does not answer.
- **Every upstream request is checked** (`utils/upstream_trace.py`): one
  bound for anywhere but `127.0.0.1:<port>` is stopped before it is sent,
  and nothing is recorded.
- **The run is fingerprinted.** `harness_sha` is a sha of what every item
  shares, read back from the first request actually sent upstream (the
  entry, the system message, the tools, every param, the 8-round limit).
  It sits beside `system_sha` as a grouping key, and a run whose request
  changes between items stops. Like the system prompt, it is not part of
  `config_id`.
- **Only the final answer is graded**: the text after the last code run,
  graded by the dataset's own tests, as in bare mode. The whole output is
  kept in `benchmark_answer.output`, and `harness_stats` records the
  rounds, code runs and output tokens in place of llama.cpp's timings.

Where it stands:

- It is reachable through the API only (`POST /api/v1/benchmarks/tests/run`
  or `/item` with `harness_model`). The Tests page has no switch for it yet,
  and Compare and Report leave harness rows out until they group by
  `harness_sha`; both are planned in PR 2 of
  [the plan](../plans/benchmarks-through-the-app.md).
- It needs a model that makes structured tool calls. `qwen25c` writes its
  `execute_code` call as JSON text, so no code runs and a harness run on it
  measures the bare model plus the entry's prompt. `qwen38` makes the
  structured call. `harness_stats.code_runs` tells the two apart.

The full rules and what each recorded field means are in
[benchmarks.md's harness section](benchmarks.md#through-the-app-harness-mode).
