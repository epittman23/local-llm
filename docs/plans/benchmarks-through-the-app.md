# Plan: run benchmarks through the app's chat pipeline

Status: **proposed on 2026-10-24, awaiting the owner's decisions** (section 3).
No code has been written for it.

Scope: an optional mode for the Benchmarks Tests page, and later Tune, in
which each scored item is answered by the assistant as deployed: a
Workspace model entry, its system prompt, and the code interpreter on the
Jupyter engine. Today every item goes straight to `llama-server`'s
`/v1/chat/completions` (`benchmarks/evaluation/runner.py`, `ask()`), so the
benchmarks measure the bare model, never the assistant.

What was read: AGENTS.md, `docs/guides/benchmarks.md` and
`assistant-tools.md`; `runner.py`; `main.py`'s `chat_completion`,
`_process_chat`, `_fan_out_chat`, `_merge_chat_params` and
`_chat_stream_params`; `utils/middleware.py`'s payload, response and
streaming-reply code; `tools/utils.py` and `tools/builtin.py`;
`routers/openai.py`'s routing; `utils/response.py`'s usage merging;
`utils/code_interpreter.py`; `models/benchmarks/tests.py`; and
`benchmarks/analysis/compare.py`. File and line references below are as of
`be5cd9d` plus #411 and #413.

---

## 1. Summary

- **The pipeline cannot be called as a function that returns an answer.**
  On every path that runs the code interpreter, `chat_completion` returns
  `None`. The answer exists only in the response context, in websocket
  events, or in a saved chat row, and errors turn into
  `chat:message:error` events instead of exceptions. The mode has to run
  the pipeline's steps itself and capture its events (D2).
- **Code runs only on the streaming path with an event emitter**, which
  needs a truthy `chat_id` and `message_id`. A `temporary:` chat id gives
  that with no chat row written.
- **The pipeline adds far more than the code interpreter.** In native
  function-calling mode it offers about a dozen builtin tools. Some of them
  browse the user's knowledge bases, chats and notes, and `ask_user` pauses
  the reply and loses the answer. The mode has to choose the tool set
  explicitly and record it (D3).
- **Nothing in the result says which connection answered.** A workspace
  model on OpenRouter would be filed under a local `config_id` without any
  error. The mode has to prove the request went to the `llama-server` being
  measured, or refuse to record it (D4).
- **Graders would read the wrong text.** The flat `content` string holds
  every round's prose, and in legacy mode the raw interpreter tags and
  code too. Grading has to read only the final message (D6).
- **Per-call speed stops meaning anything.** llama.cpp's `timings` survive
  only for the last upstream call of an item. Passes per minute should use
  wall-clock time, and tokens per second should not be shown for these rows
  (D7).

## 2. How a run would work

For one item:

1. Build the request as the app's own chat does, for a chosen Workspace
   model entry: one user message holding the item; `stream=True`;
   `temperature=0` and `max_tokens` set at the top level, where they win
   over the entry's own params; `features={'code_interpreter': True}`
   (D5); no `memory`, `files`, `folder_id` or `background_tasks`.
2. Use `chat_id='temporary:<uuid>'` and a fresh message id. The emitter
   then exists, and nothing is written to the chat tables.
3. Call `process_chat_payload`, then `generate_chat_completion`, then
   `build_chat_response_context`. Swap in a capturing event emitter, then
   call `process_chat_response`, and read `ctx['assistant_message']`.
   Do `_process_chat`'s `finally` cleanup itself.
4. Grade the final message text (D6), and store the whole `output` list in
   `benchmark_answer`, so the Answers page shows the code that ran.
5. Record the result under the usual keys plus a new `harness_sha` (D5).

The whole item runs under the existing per-item timeout
(`LLAMA_TEST_TIMEOUT`). Jupyter's own timeout only limits silence between
kernel messages.

## 3. Decisions for the owner

Each decision has a recommendation. **D3, D4 and D5 decide whether the
results can be trusted at all**, so they are the ones to settle first.

**D1. Scope of the first version.** Recommended: the Tests page only, for
both suite runs and single items. Tune follows in a later PR, because it
moves `llama-server` to a new port for each candidate, and the routing
guard (D4) has to follow it there.

**D2. How to call the pipeline.** Recommended: in process, step by step,
as in section 2. The alternatives are worse:

- HTTP with an API key returns `None` too.
- A saved chat that is read back and deleted brings every saved-chat side
  effect with it: titles, tags, events and analytics rows.

The cost is coupling. The mode depends on those four internal functions,
so a characterization test has to pin their behaviour.

**D3. Which user and which tools.** Recommended:

- **The user:** the admin who starts the run, with no memory, no files and
  no folder.
- **The tools:** after `process_chat_payload`, cut the tool list down to
  exactly `execute_code`, and record that list in the harness key.

Without the cut, the model could browse the owner's notes and chats in the
middle of a benchmark, and the tool descriptions alone would change the
prompt bytes. The alternative is a dedicated benchmark user with nothing
in its account. It is cleaner, but it is one more account to keep, and it
still needs the cut, because builtin tools are offered by model, not by
user.

**D4. The routing guard.** Recommended: two checks, and refuse to record
when either fails.

1. **Before the call:** resolve the model entry to its base model, then to
   `OPENAI_MODELS[base]['urlIdx']`, then to the connection's base URL.
   Require `http://127.0.0.1:<served port>` or `localhost`. Refuse pipe,
   Ollama and arena models.
2. **During the call:** wrap `routers/openai.py`'s `_chat_request_target`,
   and check the URL each upstream call actually uses. This catches what
   the first check cannot see: the custom-model fallback, a refreshed model
   cache, and an inlet filter rewriting the model.

This needs one-time setup from the owner: an OpenAI-compatible connection
in Admin Settings > Connections pointing at `http://127.0.0.1:8090/v1`, and
a Workspace model entry on it. That is the same change that would move
chat to local inference, but limited to one model entry.

**D5. The grouping key.** Recommended: add a nullable `harness_sha`
column beside `system_sha`. NULL means a bare request, so every existing
row keeps its meaning. It is a sha of a canonical JSON of:

- the model entry's id;
- the sha of the system prompt actually sent, taken from the first
  upstream request's messages through the same hook as D4;
- the function-calling mode;
- the features turned on;
- the sorted names of the tools offered;
- the code interpreter's engine and the sha of its prompt.

The JSON itself goes in a small new `benchmark_harness` table keyed by the
sha, so the Compare and Answers pages can show what a key means.

The pass-rate query, Compare and Report group on `harness_sha` exactly as
they do on `system_sha` today. A harness run is then never averaged with a
bare run, or with a run under a different prompt or tool set. Like the
system prompt, the harness is **not** part of `config_id`, which still
covers the serving flags only, so existing ids are unchanged. That means no
`benchmark_schema_note` row is needed, and a migration adds the column and
the table (the `new-migration` skill).

The first version turns on only the code interpreter. Web search and
knowledge are left off, because they make a run depend on the internet
and on the owner's own documents.

**D6. What is graded.** Recommended: the text of the `message` items after
the last `open_webui:code_interpreter` or `function_call_output` item in
`output`. It is not the `content` string, and not `get_output_text`, which
joins every round. A model that answers only inside a code block would
then grade as empty. That is correct for these suites, where the answer is
the code the model gives back, not code it ran.

**D7. Timing and speed.** Recommended: record, for each item:

- the wall-clock time;
- the number of upstream calls (rounds);
- the summed `output_tokens`;
- the time spent in code execution.

Passes per minute uses wall-clock time. Compare leaves the tokens-per-second
columns empty for harness rows, because the stored `timings` cover the last
round only. A number that mixes one-call items with five-round items would
read as a speed difference.

**D8. Errors.** Recommended: the capturing emitter turns
`chat:message:error`, and an upstream stream error, into the runner's
existing `fail_error`, or into `ServerGone` when `llama-server` stopped
answering. A failed item is then recorded as a failure, never as an empty
answer.

## 4. Proposed pull requests

1. **Backend: the mode on the Tests page.** The migration (`harness_sha`
   and `benchmark_harness`), the runner mode (section 2 and D2 to D8), and
   the routing guard, plus tests:
   - a characterization test of the four pipeline steps;
   - grading of a multi-round output;
   - the guard refusing an OpenRouter-backed entry;
   - errors becoming failures.

   It also needs a real run against `llama-server`.
2. **Compare, Report and the pages.** Grouping by `harness_sha`, an
   "answered through the app" column and filter, a model-entry picker on
   the Tests page, and the docs (`benchmarks.md`, decisions, roadmap).
3. **Tune.** The same mode per candidate, with the guard following each
   candidate's port.

Each one is opened as a draft and marked ready only after the owner has
read it, since auto-merge would otherwise merge a green PR, schema change
included, with nobody having looked at it.

## 5. Risks that remain

- **The pipeline's internals move.** The four functions are inherited code
  with no stable interface. The characterization test is what notices a
  change.
- **Kernel start-up time is counted in wall time.** Each code block starts
  a fresh kernel. A trivial block took 0.88 to 0.91 s end to end, measured
  on 2026-10-24, and that time is counted as part of the item. That is honest, since chat users wait for it too, but it
  makes harness runs slower than bare runs for reasons unrelated to the
  model.
- **A multi-round item costs more of the context budget.** `max_tokens`
  caps each upstream call, not the item, so an item can use several times
  the bare budget. The number of rounds is recorded (D7), so this can be
  seen.
