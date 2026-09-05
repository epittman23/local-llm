# System prompts

Named system prompts for `llama-test --system <name>`, one file per prompt.
`llama-test list` prints them with their shas.

These are **not** test items and carry no ground truth: nothing here is graded,
and nothing here is authored to be answered. A benchmark item still comes only
from a published dataset, downloaded into the gitignored `tests/data/` and
pinned by revision. What a file here does is fix a *request* variable, so that
"does the assistant's system prompt cost pass rate on this serving
configuration?" is a question with a recorded answer rather than a guess.

A run records the file's name and the SHA-1 of its exact bytes, and
`llama-test compare` groups by that sha, so:

- Editing a file makes a new prompt. Runs made before the edit keep their own
  sha and are never averaged with runs made after it, even though the name did
  not change.
- No `--system` at all records NULL, which the database's own schema note
  defines as "no system prompt was sent", not "unknown".

## The set, and what each one isolates

`assistant.txt` is the deployed prompt and the reason the rest exist. The other
four are a rewrite of it for local models and an ablation of that rewrite: each
drops one thing from the one above it, so a `compare` table reads as an
attribution rather than five unrelated strings. None of them is deployed
anywhere; Open WebUI still serves `assistant.txt`.

| file | what it is | what it answers |
| --- | --- | --- |
| `assistant.txt` | the Open WebUI prompt, verbatim | what the assistant's real prompt costs, unmodified |
| `assistant-local.txt` | the same six intents, rewritten for a small local model | can the rewrite recover whatever the original costs, without giving up tone, assumptions or teaching |
| `assistant-direct.txt` | `assistant-local` minus "explain the steps" | how much of the cost is verbosity |
| `style-only.txt` | tone and punctuation rules only | whether the style rules alone cost anything |
| `minimal.txt` | answer directly, code in one fence | the floor: what any prose at all costs against none |

Three things the rewrite changes, each for a reason that shows up on a local
model and not on a hosted one:

- **The clarifying-question clause is made conditional.** "Do not hesitate to
  ask clarifying questions before providing a full response" is fine in a chat
  window and is a scored failure on a single-turn item: a model that asks
  instead of answering produces no code, and that is a real behaviour of the
  deployed prompt rather than an artifact of the harness. The rewrite keeps the
  intent (state assumptions, invite correction) and moves the question after
  the answer instead of in place of it.
- **The verbosity clauses are bounded.** `LLAMA_TEST_MAX_TOKENS` is 2048, and a
  7B model told to "delve into topics" can spend that budget on prose and get
  cut off mid-function. A truncated answer grades as wrong and looks like a
  quality problem rather than a length one.
- **Formatting is stated.** The graders extract the last fenced block that
  contains a definition, and an unfenced answer is passed to the grader whole.

That last point is a **confound and is stated rather than buried**: all four
rewrites name the fence and `assistant.txt` does not, so an `assistant` versus
`assistant-local` delta mixes the rewrite with formatting compliance. The
comparison among the four rewrites is clean, because the fence instruction is
identical in all of them.

## Keeping `assistant.txt` honest

`assistant.txt` is the text configured per-model in Open WebUI (see the "Model
setup" section of `README.md`). It is a copy, kept so a benchmark run can be
made under the deployed prompt: Open WebUI remains the source of truth for what
the assistant actually serves, and this repo holds no assistant configuration.
If the prompt is changed there, copy it here in the same change or the
comparison silently measures a prompt nobody is using.

The same rule cuts the other way. If one of the rewrites measures better and is
adopted, it is adopted **in Open WebUI**, and `assistant.txt` is updated to
match in the same change. A file here winning a benchmark changes nothing on
its own.

## Adding one

Drop in a `.txt` file. The bytes are sent verbatim with the trailing newline
stripped, so anything you write is what the model sees; nothing is normalised,
because a sha that described normalised text would not describe what was sent.
Prefer editing nothing in place once a run exists under it: a new name keeps
both prompts legible in `compare`, where an edit leaves two shas under one name
and a caveat line explaining why.
