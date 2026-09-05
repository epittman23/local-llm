#!/usr/bin/env python3
"""llama_test.py - run benchmark items against the local server, grade, record.

Part of https://github.com/epittman23/local-llm

This is the body of `llama-test`; the shell function of that name is now a thin
wrapper around it (scripts/llama-env.sh). It replaced a bash implementation, and
several of that implementation's decisions are load-bearing and are preserved
here deliberately:

  * The model name is read from GET /v1/models, not taken from the profile. The
    profile says what *would* be served; the server is already serving
    something, and an earlier version labelled a run with the wrong alias.
  * temperature is pinned to 0 and cache_prompt defaults to false, so a repeated
    prompt measures the configuration rather than the prefix cache.
  * Request parameters are read back out of the built body rather than
    re-derived, so the log records the request that was sent.
  * The answer goes to stdout and the model's thinking to stderr, so
    `llama-test humaneval/HumanEval/0 > answer.md` still captures the completion
    alone. Rich rendering only ever touches stderr.

Every graded item is one committed transaction in logs/llama.db: the request's
llama.cpp timings (how fast did it answer), the verdict (did it answer
correctly) and the full response, linked to each other and to the serving run
that produced them. Those were three separate writes to three stores with
nothing joining them, which is the thing the database was for.

GRADING EXECUTES MODEL-GENERATED PYTHON in a subprocess under a timeout. See
llama_tests.py; that is process isolation, not a sandbox.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llama_db as db
import llama_results as store
import llama_tests as bench
from llama_console import console, wanted, write_markdown

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"


# ---------------------------------------------------------------------------
# profile + server
# ---------------------------------------------------------------------------
def profile(name: str | None) -> dict:
    """Resolve a serving profile by asking llama-env.sh, not by copying it.

    scripts/llama-env.sh is the single source of truth for serving configuration
    (CLAUDE.md). Re-declaring the profile table here would create a second one,
    and the two would disagree the first time either changed.
    """
    argv = [str(ENV_SH), "profile-json"] + ([name] if name else [])
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        if proc.returncode == 0:
            return json.loads(proc.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return {}


def port(prof: dict) -> int:
    return int(os.environ.get("LLAMA_PORT") or prof.get("port") or 8090)


def served_model(p: int, prof: dict, con) -> str:
    """What the server is actually serving, falling back to the profile alias."""
    alias = prof.get("alias", "")
    try:
        with urllib.request.urlopen(
                f"http://localhost:{p}/v1/models", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        served = (data.get("data") or [{}])[0].get("id", "")
    except (urllib.error.URLError, OSError, ValueError, IndexError):
        return alias
    if served and alias and served != alias:
        con.warn(f"port {p} is serving '{served}', not profile "
                 f"{prof.get('name', '?')}'s '{alias}' - testing what is running")
    return served or alias


def active_run(conn, p: int) -> dict:
    """The serving run the telemetry recorder is currently writing, if any.

    Gives a test result its config-id and its run, which is what joins it to the
    telemetry that produced it. This was a file the recorder wrote and an EXIT
    trap removed, so a kill -9 left a stale marker that later results were filed
    under; it is now a run row with ended_at IS NULL, and a run whose recorder
    is gone is closed by the sweep in llama_db.connect() before this looks.

    A hand-started server has no open run. That is recorded as "unrecorded"
    rather than guessed at -- the same choice the marker file made.
    """
    return db.active_run(conn, p) or {}


# ---------------------------------------------------------------------------
# system prompts
#
# Named files under prompts/system/, not text on the command line: a run records
# which prompt it used, and a name is only worth recording if the bytes behind
# it can be recovered later. The sha travels beside the name for the case the
# name cannot cover -- a file edited in place is a different prompt under the
# same name, and grouping by name alone would average the two.
#
# This is the same prompts/ directory the 2026-08-30 decision deleted, and the
# rule that deleted it is intact: nothing here is a test item and nothing here
# is graded. Ground truth still comes only from the published datasets.
# ---------------------------------------------------------------------------
SYSTEM_DIR = Path(__file__).resolve().parent.parent / "prompts" / "system"


def system_names() -> list[str]:
    if not SYSTEM_DIR.is_dir():
        return []
    return sorted(p.stem for p in SYSTEM_DIR.glob("*.txt"))


def load_system(name: str | None) -> dict:
    """Resolve --system <name> to {name, text, sha}, or {} for none.

    The text is used verbatim, trailing newline stripped and nothing else
    touched: a system prompt is bytes the model sees, so normalising whitespace
    here would mean the recorded sha did not describe what was sent.
    """
    if not name:
        return {}
    path = SYSTEM_DIR / f"{name}.txt"
    if not path.is_file():
        known = ", ".join(system_names()) or "none defined"
        raise SystemExit(f"llama-test: no system prompt '{name}' in "
                         f"{SYSTEM_DIR} (known: {known})")
    text = path.read_text(encoding="utf-8").rstrip("\n")
    if not text.strip():
        raise SystemExit(f"llama-test: system prompt '{name}' is empty")
    return {"name": name, "text": text,
            "sha": hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]}


# ---------------------------------------------------------------------------
# request
# ---------------------------------------------------------------------------
def build_body(prompt: str, model: str, prof: dict, stream: bool,
               system: dict | None = None) -> dict:
    messages = []
    if system and system.get("text"):
        messages.append({"role": "system", "content": system["text"]})
    messages.append({"role": "user", "content": prompt})
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": int(os.environ.get("LLAMA_TEST_MAX_TOKENS", 2048)),
        "temperature": 0,
        "cache_prompt": os.environ.get("LLAMA_TEST_CACHE_PROMPT", "0") == "1",
    }
    # reasoning_effort only reaches models whose template actually serves it;
    # sending it elsewhere would silently mean nothing while looking configured.
    if "reasoning_effort" in " ".join(prof.get("extra", [])):
        body["chat_template_kwargs"] = {
            "reasoning_effort": os.environ.get("LLAMA_REASONING", "medium")}
    if stream:
        body["stream"] = True
    return body


PARAM_KEYS = ("temperature", "top_p", "top_k", "max_tokens", "cache_prompt",
              "stream", "chat_template_kwargs")


def system_of(body: dict) -> str:
    """The system message actually in the body, or "".

    Read back out of the request rather than carried alongside it, for the same
    reason params_of is: what gets recorded should be what was sent. A caller
    that forgot to thread the prompt through would otherwise record one anyway.
    """
    for message in body.get("messages", []):
        if message.get("role") == "system":
            return message.get("content", "")
    return ""


def params_of(body: dict) -> dict:
    """What the log should record: read back out of the body, not re-derived."""
    params = {k: body[k] for k in PARAM_KEYS if body.get(k) is not None}
    text = system_of(body)
    if text:
        params["system_sha"] = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    return params


class ServerGone(RuntimeError):
    """The server stopped answering, so there is nothing to grade.

    Raised instead of recording an outcome. A benchmark result is a statement
    about a model's answer, and a connection refused is not one: recording it
    as `fail_error` files a serving failure as a model failure, and because
    (suite_run_id, benchmark, item_id) is unique, `--resume` then skips the
    item forever. Raising leaves the item genuinely undone.
    """


class Answer:
    def __init__(self):
        self.content = ""
        self.reasoning = ""
        self.timings: dict = {}
        self.wall_ms = 0.0
        self.error = ""
        # True when the request never produced a completion because the
        # connection failed, as opposed to the model answering badly.
        self.gone = False


def ask(prompt: str, model: str, prof: dict, p: int, con,
        stream: bool = True, show: bool = True,
        system: dict | None = None) -> Answer:
    """One chat completion. Streams by default."""
    body = build_body(prompt, model, prof, stream, system)
    req = urllib.request.Request(
        f"http://localhost:{p}/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    timeout = float(os.environ.get("LLAMA_TEST_TIMEOUT", 900))

    out = Answer()
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if stream:
                _read_sse(resp, out, con, show)
            else:
                payload = json.loads(resp.read().decode("utf-8"))
                message = (payload.get("choices") or [{}])[0].get("message", {})
                out.content = message.get("content") or ""
                out.reasoning = message.get("reasoning_content") or ""
                out.timings = payload.get("timings") or {}
                if show:
                    sys.stdout.write(out.content)
                    sys.stdout.flush()
    except urllib.error.HTTPError as exc:
        out.error = f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}"
    except (urllib.error.URLError, OSError) as exc:
        # Connection refused, and also a stream that died mid-read: in both
        # cases no completion arrived. HTTPError is deliberately not in here --
        # the server answered, and a 400 can be item-specific (a prompt past
        # the context window), which is a per-item fact worth recording.
        out.gone = True
        out.error = (f"no response from port {p} ({exc}); "
                     f"is llama-serve running?")
    except json.JSONDecodeError as exc:
        out.error = f"unparseable response: {exc}"
    out.wall_ms = (time.time() - t0) * 1000
    return out


def _read_sse(resp, out: Answer, con, show: bool) -> None:
    """Render an OpenAI SSE stream: answer to stdout, thinking to stderr.

    Written against the byte stream rather than forking jq per chunk, which is
    what the bash version did -- at three tokens a second that fork was not a
    bottleneck, but it made the answer/thinking split a shell quoting problem.
    """
    thinking = answering = False
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        if isinstance(chunk.get("timings"), dict):
            out.timings = chunk["timings"]
        delta = (chunk.get("choices") or [{}])[0].get("delta") or {}

        reasoning = delta.get("reasoning_content")
        if reasoning:
            out.reasoning += reasoning
            if show:
                if not thinking:
                    con.rule("thinking")
                    thinking = True
                con.stream.write(reasoning)
                con.stream.flush()

        content = delta.get("content")
        if content:
            out.content += content
            if show:
                if not answering:
                    con.rule("response")
                    answering = True
                sys.stdout.write(content)
                sys.stdout.flush()
    if show:
        sys.stdout.write("\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# running items
# ---------------------------------------------------------------------------
def run_item(row: dict, ctx: dict, con, show: bool) -> dict:
    """Ask one item, grade it, record it. Returns the stored record.

    One transaction writes the request timings, the verdict and the answer, and
    it commits before the next item is asked. That is what makes an interrupted
    suite a partial result rather than no result, and on this hardware a `full`
    run is long enough that it will be interrupted.
    """
    adapter, item = row["adapter"], row["item"]
    prompt = bench.render_prompt(adapter, item)
    name = f"{row['benchmark']}/{row['item_id']}"

    ans = ask(prompt, ctx["model"], ctx["profile"], ctx["port"], con,
              stream=ctx["stream"], show=show, system=ctx.get("system"))

    # Before anything is written: a dead server is not a verdict about this
    # item, and writing one would both understate the model and, via the
    # uniqueness constraint, make the item unresumable.
    if ans.gone:
        raise ServerGone(ans.error)

    if ans.error:
        outcome, reason = "fail_error", ans.error
    else:
        outcome, reason = bench.grade(adapter, item, ans.content)

    record = {
        "suite_run_id": ctx["suite_run_id"],
        "run_id": ctx["run_id"],
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": ctx["model"],
        "config_id": ctx["config_id"],
        "profile": ctx["profile"].get("name", ""),
        "benchmark": row["benchmark"],
        "dataset_revision": ctx["revisions"].get(row["benchmark"], ""),
        "tier": ctx["tier"],
        "seed": ctx["seed"],
        "item_id": row["item_id"],
        "outcome": outcome,
        "reason": reason[:400],
        "wall_ms": round(ans.wall_ms),
        "timings": ans.timings,
        "params": ctx["params"],
        # Empty for no system prompt; add_result stores that as NULL, which the
        # schema note defines as "none sent" rather than "unknown".
        "system_name": (ctx.get("system") or {}).get("name", ""),
        "system_sha": (ctx.get("system") or {}).get("sha", ""),
        # The wrapper this repo puts around the published item. dataset_revision
        # covers the item; this covers the prompt_template and grading config
        # that turn it into a request, which nothing pinned before.
        "adapter_sha": adapter.get("_sha", ""),
        "reasoning_chars": len(ans.reasoning),
    }
    # The answer is stored as three fields rather than one rendered blob, so
    # "the failures whose reasoning ran past 15k characters" is a SELECT instead
    # of a grep over a thousand files. The rendering survives as `llama-test
    # answer`, which builds it on demand.
    answer = None if ans.error else {
        "prompt": prompt, "content": ans.content, "reasoning": ans.reasoning}
    record["result_id"] = store.append(ctx["db"], record, answer)
    return record


def _answer_document(row: dict, collapse: bool = True) -> str:
    """One stored answer, rendered with enough context to be read on its own.

    Built on demand from a joined result+answer row rather than written to
    logs/answers/<run>/<item>.md as every item finished. The file layout is
    still reachable -- `llama-test answer --export <dir>` writes exactly it --
    but a full-tier run no longer leaves a thousand files behind to produce it.

    `collapse` wraps the chain of thought in <details>, which is what a file
    wants and what a terminal cannot do anything with: nothing in a terminal
    expands one, and Rich's markdown drops raw HTML blocks, so a collapsed
    document rendered to a TTY would show the reasoning with no heading at all.
    The printing path passes collapse=False; every file written stays byte for
    byte what it was.
    """
    name = f"{row['benchmark']}/{row['item_id']}"
    timings = row.get("timings") or {}
    reasoning = row.get("reasoning") or ""
    parts = [f"# {name}", "",
             f"- model: `{row['model']}`",
             f"- config-id: `{row.get('config_id') or 'unrecorded'}`",
             f"- suite run: `{row['suite_run_id']}`",
             # Named here because the stored prompt below is the user message
             # only: without this line an answer read back on its own gives no
             # sign that a system prompt shaped it.
             f"- system prompt: "
             + (f"`{row['system_name']}` (sha `{row.get('system_sha') or '?'}`)"
                if row.get("system_name") else "none"),
             f"- recorded: {row['at']}",
             f"- outcome: **{row['outcome']}**"
             + (f" - {row['reason']}" if row.get("reason") else ""), ""]
    if timings:
        parts += [f"- prompt: {timings.get('prompt_n', '?')} tokens at "
                  f"{_rate(timings.get('prompt_n'), timings.get('prompt_ms')):.2f} t/s",
                  f"- generated: {timings.get('predicted_n', '?')} tokens at "
                  f"{_rate(timings.get('predicted_n'), timings.get('predicted_ms')):.2f} t/s", ""]
    parts += ["## prompt", "", "````", row.get("prompt") or "", "````", ""]
    if reasoning and collapse:
        parts += ["## thinking", "",
                  "<details><summary>chain of thought "
                  f"({len(reasoning)} chars)</summary>", "",
                  "````", reasoning, "````", "", "</details>", ""]
    elif reasoning:
        # Prose, and never graded, so let it reflow to the terminal's width. In
        # a code block Rich would crop every line past the margin, and a
        # reasoning trace on this model runs to tens of thousands of characters.
        parts += [f"## thinking ({len(reasoning)} chars)", "", reasoning, ""]
    content = row.get("content") or ""
    if not collapse and _has_fence(content):
        # The model fenced its own code, so hand the markdown over intact and
        # let it be highlighted -- which is the whole reason to render at all.
        parts += ["## response", "", content, ""]
    else:
        # No fence of its own: keep ours, because the graded text is code and
        # reflowing it into paragraphs would destroy the indentation that makes
        # it code. Unhighlighted and correct beats highlighted and wrong.
        parts += ["## response", "", "````", content, "````", ""]
    return "\n".join(parts)


def _has_fence(text: str) -> bool:
    """Whether the model wrapped its answer in a code fence of its own.

    Deliberately not the extractor in llama_tests: that one decides what gets
    graded and must stay strict. This only decides how to print, and a wrong
    guess costs highlighting, not correctness.
    """
    return any(line.lstrip().startswith("```") for line in text.splitlines())


def _rate(n, ms) -> float:
    try:
        return (float(n) / float(ms)) * 1000 if n and ms else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def context(args, con, tier: str, seed: int, benches: list[str]) -> dict:
    """Everything a run of items is measured under, resolved once.

    Two ids, and they are not the same thing. `suite_run_id` names this
    invocation of llama-test and is what --resume continues; `run_id` names the
    serving run the telemetry recorder has open, and is NULL for a server
    someone started by hand. A result carries both, plus a denormalised
    config_id so it keeps its configuration identity even if its run row is
    later pruned.
    """
    conn = db.connect()
    prof = profile(args.profile)
    p = port(prof)
    model = served_model(p, prof, con)
    active = active_run(conn, p)
    stream = os.environ.get("LLAMA_TEST_STREAM", "1") != "0"
    system = load_system(getattr(args, "system", None))
    body = build_body("", model, prof, stream, system)
    revisions = {}
    for b in benches:
        manifest = bench.read_manifest(b) or {}
        revisions[b] = manifest.get("revision") or manifest.get("content_sha256", "")
    return {
        "db": conn,
        "suite_run_id": args.run_id or f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:6]}",
        "run_id": active.get("run_id"),
        "model": model, "profile": prof, "port": p, "stream": stream,
        # None, not "unrecorded": the column is a foreign key into config,
        # and the display layer is where a missing configuration gets a name.
        "config_id": active.get("config_id"),
        "tier": tier, "seed": seed, "revisions": revisions,
        "system": system,
        "params": params_of(body),
    }


def cmd_run(args) -> int:
    """One item, named as <benchmark>/<item-id>."""
    con = console()
    adapters = bench.load_adapters()
    target = args.item
    if "/" not in target:
        raise SystemExit("llama-test: name an item as <benchmark>/<item-id>, "
                         "e.g. humaneval/HumanEval/0")
    name, item_id = target.split("/", 1)
    adapter = adapters.get(name)
    if adapter is None:
        raise SystemExit(f"llama-test: unknown benchmark '{name}' "
                         f"(known: {', '.join(sorted(adapters))})")
    match = next((it for it in bench.read_items(name)
                  if bench.item_id(adapter, it) == item_id), None)
    if match is None:
        raise SystemExit(f"llama-test: no item '{item_id}' in {name}")

    row = {"benchmark": name, "adapter": adapter, "item": match,
           "item_id": item_id}
    ctx = context(args, con, "single", 0, [name])
    con.note(f"llama-test: {target} model={ctx['model']} port={ctx['port']} "
             f"config={ctx['config_id'] or 'unrecorded'} "
             f"system={_system_label(ctx)} "
             f"stream={ctx['stream']}")

    try:
        record = run_item(row, ctx, con, show=True)
    except ServerGone as exc:
        ctx["db"].close()
        raise SystemExit(f"llama-test: {exc}") from None
    _report_one(con, record, target)
    ctx["db"].close()
    return 0 if record["outcome"] == store.PASS else 1


def _system_label(ctx: dict) -> str:
    """How a run's system prompt is named on screen: name@sha, or "none"."""
    system = ctx.get("system") or {}
    return f"{system['name']}@{system['sha']}" if system else "none"


def _report_one(con, record: dict, target: str) -> None:
    t = record.get("timings") or {}
    con.rule("result")
    style = "green" if record["outcome"] == store.PASS else "bold red"
    con.say(f"{record['benchmark']}/{record['item_id']}: {record['outcome']}"
            + (f" - {record['reason']}" if record["reason"] else ""), style)
    if t:
        con.note(f"prompt {t.get('prompt_n', '?')} tok at "
                 f"{_rate(t.get('prompt_n'), t.get('prompt_ms')):.2f} t/s | "
                 f"generated {t.get('predicted_n', '?')} tok at "
                 f"{_rate(t.get('predicted_n'), t.get('predicted_ms')):.2f} t/s | "
                 f"wall {record['wall_ms'] / 1000:.1f}s")
    con.note(f"stored as result {record['result_id']} in {store.db_path()}; "
             f"read it back with: llama-test answer {target}")


def cmd_suite(args) -> int:
    con = console()
    adapters = bench.load_adapters()
    suite = bench.load_suite(args.suite)
    selected, skipped = bench.build_suite(suite, adapters, only=args.benchmark)
    if not selected:
        raise SystemExit(f"llama-test: suite '{args.suite}' selected no items")

    # Checked once up front: importing pandas costs about a second, and a full
    # DS-1000 run would otherwise pay it 500 times to learn the same fact.
    blocked = bench.missing_libraries(selected)
    if blocked:
        selected = [r for r in selected
                    if f"{r['benchmark']}/{r['item_id']}" not in blocked]
        for key, why in blocked.items():
            b, iid = key.split("/", 1)
            skipped.append({"benchmark": b, "item_id": iid, "reason": why})

    for name in sorted({r["benchmark"] for r in selected}):
        stale = bench.calibration_stale(name)
        if stale:
            con.warn(f"{name} is not calibrated for this environment "
                     f"({stale}); items its own reference solutions cannot "
                     f"pass here will be scored as failures. "
                     f"run: llama-test selfcheck {name}")

    ctx = context(args, con, suite["id"], int(suite.get("seed", 0)),
                  sorted({r["benchmark"] for r in selected}))
    if args.resume:
        prior = store.latest_run(ctx["db"], model=ctx["model"], suite=suite["id"])
        if prior:
            ctx["suite_run_id"] = prior
            con.note(f"resuming run {prior}")
        else:
            con.note("nothing to resume; starting a new run")
    done = store.completed(ctx["db"], ctx["suite_run_id"])
    todo = [r for r in selected if (r["benchmark"], r["item_id"]) not in done]

    con.rule(f"suite {suite['id']}")
    con.note(f"model={ctx['model']} config={ctx['config_id'] or 'unrecorded'} "
             f"run={ctx['suite_run_id']} seed={ctx['seed']} "
             f"system={_system_label(ctx)}")
    con.note(f"{len(todo)} to run, {len(done)} already done, "
             f"{len(skipped)} excluded")

    # Exclusions are recorded, not merely counted -- but once, against the
    # benchmark and dataset revision they belong to, rather than as one row per
    # item per run. As per-run rows a 24-item smoke suite wrote 569 records, 545
    # of them exclusions repeated verbatim every time, so a count of a suite's
    # rows described the adapter's library filter rather than the run. Whether
    # an item is outside the filter, or ungradeable on this pandas, is a
    # property of the benchmark and this box; nothing about a serving run
    # changes it.
    store.exclusions(ctx["db"], [
        {"benchmark": s["benchmark"], "item_id": s["item_id"],
         "dataset_revision": ctx["revisions"].get(s["benchmark"], ""),
         "kind": s.get("kind", "unattemptable"), "reason": s["reason"]}
        for s in skipped])

    results: list[dict] = []
    started = time.time()
    show = args.show
    try:
        for i, row in enumerate(todo, 1):
            con.rule(f"[{i}/{len(todo)}] {row['benchmark']}/{row['item_id']}")
            record = run_item(row, ctx, con, show=show)
            results.append(record)
            passed, attempted, rate = store.pass_rate(results)
            style = "green" if record["outcome"] == store.PASS else "yellow"
            con.say(f"  {record['outcome']}"
                    + (f" - {record['reason'][:120]}" if record["reason"] else "")
                    + f"   [{passed}/{attempted} passing]", style)
    except KeyboardInterrupt:
        # The database is already complete up to the last finished item, because
        # each one is its own committed transaction. Say so, since the whole
        # point of that choice is that an interrupted run is still usable.
        con.warn(f"interrupted after {len(results)} items; "
                 f"{store.db_path()} holds them. resume with: "
                 f"llama-test --suite {suite['id']} --resume")
        summarise(con, ctx, results, time.time() - started)
        ctx["db"].close()
        return 130
    except ServerGone as exc:
        # Same shape as the interrupt above, and for the same reason: the
        # finished items are committed and the unfinished ones were never
        # written, so --resume picks up exactly where the server died. The
        # summary below covers what was actually measured, which is the whole
        # point of not recording the remaining items as failures.
        con.warn(f"{exc}")
        con.warn(f"aborted after {len(results)} of {len(todo)} items; "
                 f"the rest were not recorded. restart the server, then: "
                 f"llama-test --suite {suite['id']} --resume")
        summarise(con, ctx, results, time.time() - started)
        ctx["db"].close()
        return 1

    summarise(con, ctx, results, time.time() - started)
    ctx["db"].close()
    return 0


def summarise(con, ctx: dict, results: list[dict], elapsed: float) -> None:
    if not results:
        return
    con.rule("summary")
    rows = []
    for name in sorted({r["benchmark"] for r in results}):
        subset = [r for r in results if r["benchmark"] == name]
        passed, attempted, rate = store.pass_rate(subset)
        rows.append([name, f"{passed}/{attempted}",
                     "-" if rate is None else f"{rate * 100:.1f}%"])
    passed, attempted, rate = store.pass_rate(results)
    rows.append(["all", f"{passed}/{attempted}",
                 "-" if rate is None else f"{rate * 100:.1f}%"])
    con.table(["benchmark", "passed/attempted", "pass rate"], rows)
    minutes = elapsed / 60
    con.note(f"{elapsed / 60:.1f} min elapsed"
             + (f", {passed / minutes:.2f} passes/min" if minutes > 0 else ""))
    con.note(f"records: {store.db_path()} (suite run {ctx['suite_run_id']})")
    con.note("compare configurations with: llama-test compare")


def cmd_list(args) -> int:
    con = console()
    adapters = bench.load_adapters()
    rows = []
    for name, adapter in sorted(adapters.items()):
        manifest = bench.read_manifest(name)
        if manifest is None:
            rows.append([name, adapter.get("license", "?"), "not downloaded",
                         "-", "-", "-"])
            continue
        items = bench.read_items(name)
        keep, _ = bench.filter_items(adapter, items)
        cal = bench.read_calibration(name)
        stale = bench.calibration_stale(name)
        if cal is None:
            state = "none"
        elif stale:
            state = f"stale ({stale})"
        else:
            state = f"{cal['n_checked'] - cal['n_ungradeable']}/{cal['n_checked']} gradeable"
        rows.append([name, adapter.get("license", "?"), str(len(items)),
                     str(len(keep)),
                     (manifest.get("revision") or manifest["content_sha256"])[:12],
                     state])
    con.table(["benchmark", "license", "items", "in filter", "revision",
               "calibration"], rows, title="benchmarks")

    srows = []
    for path in sorted(bench.SUITES.glob("*.toml")):
        suite = bench.load_suite(path.stem)
        parts = [f"{e['id']}={e.get('n', 0) or 'all'}"
                 for e in suite.get("benchmark", [])]
        srows.append([suite["id"], str(suite.get("seed", 0)), ", ".join(parts),
                      suite.get("description", "")])
    con.table(["tier", "seed", "composition", "purpose"], srows, title="suites")

    # The sha, not just the name, because the sha is what a result is grouped
    # by: two runs of "assistant" made either side of an edit are different
    # prompts, and this is where that becomes visible without opening the file.
    prows = []
    for name in system_names():
        system = load_system(name)
        text = system["text"]
        prows.append([name, system["sha"], str(len(text)),
                      text.splitlines()[0][:64]])
    if prows:
        con.table(["system prompt", "sha", "chars", "first line"], prows,
                  title="system prompts")
        con.note("send one with: llama-test --suite smoke --system <name>   "
                 "|   no --system sends none, which is the baseline")
    return 0


def cmd_fetch(args) -> int:
    import llama_fetch
    adapters = bench.load_adapters()
    wanted = args.benchmark or sorted(adapters)
    for name in wanted:
        if name not in adapters:
            raise SystemExit(f"llama-test: unknown benchmark '{name}'")
    for name in wanted:
        llama_fetch.fetch_one(adapters[name], force=args.force)
    return 0


def cmd_selfcheck(args) -> int:
    """Grade every reference solution: the graders' own test, with no model.

    Two things come out of it. A harness bug shows up as a benchmark scoring far
    below 100%, which is unambiguous because the dataset is grading its own
    answers. And the items this environment cannot verify are written down, so
    they can be skipped at run time instead of being charged to the model.
    """
    con = console()
    adapters = bench.load_adapters()
    wanted = args.benchmark or sorted(adapters)
    env = bench.env_fingerprint()
    con.note("grading environment: "
             + ", ".join(f"{k} {v}" for k, v in sorted(env.items())))

    rows = []
    for name in wanted:
        adapter = adapters.get(name)
        if adapter is None:
            raise SystemExit(f"llama-test: unknown benchmark '{name}'")
        items, _ = bench.filter_items(adapter, bench.read_items(name))
        con.note(f"{name}: checking {len(items)} reference solutions "
                 f"(this runs the benchmark's own answers, not a model)")
        seen = {"n": 0}

        def tick(iid, outcome, reason, _n=len(items), _s=seen, _name=name):
            _s["n"] += 1
            if _s["n"] % 25 == 0 or _s["n"] == _n:
                con.note(f"  {_name}: {_s['n']}/{_n}")

        record = bench.calibrate(name, adapter, items, on_item=tick)
        path = bench.write_calibration(name, record)
        good = record["n_checked"] - record["n_ungradeable"]
        rows.append([name, f"{good}/{record['n_checked']}",
                     str(record["n_ungradeable"]),
                     "yes" if record["n_ungradeable"] == 0 else "no"])
        con.note(f"  wrote {path}")

    con.table(["benchmark", "reference solutions passing", "ungradeable here",
               "clean"], rows, title="grader self-check")
    con.note("ungradeable items are skipped when a suite runs, never counted "
             "as model failures: the dataset's own answer could not pass here "
             "either, so the item measures the library versions, not the model.")
    return 0


def cmd_report(args) -> int:
    """The comparison, to the terminal.

    It used to be rendered into logs/tests.log after every suite. That file was
    derived from the store and rewritten whole each time, and now that the store
    is queryable there is nothing for a stale copy of it on disk to be good for.
    `--format markdown` is still here because README.md wants a measured table
    pasted into it, and that is the one thing the markdown renderer is for.
    """
    extra = []
    if args.format:
        extra += ["--format", args.format]
    if args.tier:
        extra += ["--tier", args.tier]
    return cmd_compare(None, extra)


def cmd_answer(args) -> int:
    """Print one stored answer, or export a suite run's answers as files.

    Replaces logs/answers/<run>/<item>.md, which was written for every item of
    every run whether anyone read it or not. --export writes exactly that layout
    on demand, so the way of reading answers by hand is unchanged for anyone who
    was using it.

    On a terminal the document is rendered as markdown -- headings, and the
    model's code with syntax highlighting, which is the point. Redirected, it is
    the raw document: `llama-test answer ... > answer.md` and --export produce
    the same bytes as they did before, which is the whole reason the decision
    goes through llama_console.wanted() rather than being made here.
    """
    con = console()
    conn = db.connect()

    if args.export:
        out = Path(args.export)
        run = args.run_id or store.latest_run(conn)
        if not run:
            raise SystemExit("llama-test: nothing recorded to export")
        rows = [r for r in db.results(conn) if r["suite_run_id"] == run]
        written = 0
        for r in rows:
            answer = db.answer_for(conn, r["benchmark"], r["item_id"], run)
            if not answer:
                continue
            target = out / run
            target.mkdir(parents=True, exist_ok=True)
            name = f"{r['benchmark']}_{r['item_id']}".replace("/", "_")
            (target / f"{name}.md").write_text(_answer_document(answer))
            written += 1
        con.note(f"exported {written} answers to {out / run}")
        return 0

    if not args.item or "/" not in args.item:
        raise SystemExit("llama-test: name an item as <benchmark>/<item-id>, "
                         "e.g. llama-test answer humaneval/HumanEval/0")
    name, item_id = args.item.split("/", 1)
    answer = db.answer_for(conn, name, item_id, args.run_id)
    if not answer:
        raise SystemExit(f"llama-test: no stored answer for {args.item}"
                         + (f" in run {args.run_id}" if args.run_id else ""))
    # Asked once, before the document is built, because the answer decides both
    # how it is written and how it is shaped: see _answer_document(collapse=).
    rendered = wanted(sys.stdout)
    write_markdown(_answer_document(answer, collapse=not rendered))
    return 0


def cmd_compare(args, extra: list[str]) -> int:
    import llama_compare
    return llama_compare.main(extra)


def cmd_ui(args, extra: list[str]) -> int:
    import llama_ui
    return llama_ui.main(extra)


# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    parser = argparse.ArgumentParser(
        prog="llama-test",
        description="run published benchmark items against the local server, "
                    "grade them against the benchmark's own tests, and record "
                    "the result beside the serving telemetry")
    parser.add_argument("--profile", help="serving profile (default: the "
                                          "default profile in llama-env.sh)")
    parser.add_argument("--suite", help="run a tier: smoke, standard, or full")
    parser.add_argument("--benchmark", help="restrict a suite to one benchmark")
    parser.add_argument("--system", metavar="NAME",
                        help="send a system prompt from prompts/system/"
                             "<NAME>.txt. Recorded with the result and grouped "
                             "on by `compare`, so a run with one is never "
                             "averaged with a run without. Default: none.")
    parser.add_argument("--resume", action="store_true",
                        help="continue the most recent run of this suite")
    parser.add_argument("--run-id", help="record under a specific run id")
    parser.add_argument("--quiet", dest="show", action="store_false",
                        help="do not stream the response (a long suite run)")
    parser.add_argument("item", nargs="?",
                        help="a single item as <benchmark>/<item-id>, or a "
                             "subcommand: list, fetch, selfcheck, compare, "
                             "report, answer, ui")
    # No REMAINDER catch-all here. There was one, unread and SUPPRESSed, and
    # its only effect was to swallow every flag written after the item:
    # `llama-test humaneval/HumanEval/0 --system assistant` parsed, ran, and
    # recorded a run made without the system prompt it names. Subcommand flags
    # do not need it either -- `compare` and `ui` are matched before argparse
    # and take their argv untouched. Without it argparse interleaves flags and
    # positionals normally, and an unknown flag is an error instead of silence.

    # Subcommands are matched before argparse so `llama-test compare --by
    # benchmark` passes its own flags through untouched.
    subcommands = {"list", "fetch", "selfcheck", "compare", "report", "ui",
                   "answer"}
    if argv and argv[0] in subcommands:
        name, extra = argv[0], argv[1:]
        if name == "compare":
            return cmd_compare(None, extra)
        if name == "ui":
            return cmd_ui(None, extra)
        sub = argparse.ArgumentParser(prog=f"llama-test {name}")
        if name == "fetch":
            sub.add_argument("benchmark", nargs="*")
            sub.add_argument("--force", action="store_true")
        elif name == "selfcheck":
            sub.add_argument("benchmark", nargs="*")
        elif name == "report":
            sub.add_argument("--format", choices=["rich", "markdown", "json"])
            sub.add_argument("--tier")
        elif name == "answer":
            sub.add_argument("item", nargs="?",
                             help="<benchmark>/<item-id>")
            sub.add_argument("--run-id", help="a specific suite run "
                                              "(default: the most recent)")
            sub.add_argument("--export", metavar="DIR",
                             help="write a suite run's answers as "
                                  "DIR/<run>/<benchmark>_<item>.md")
        args = sub.parse_args(extra)
        return {"list": cmd_list, "fetch": cmd_fetch,
                "selfcheck": cmd_selfcheck, "report": cmd_report,
                "answer": cmd_answer}[name](args)

    args = parser.parse_args(argv)
    if args.suite:
        return cmd_suite(args)
    if args.item:
        return cmd_run(args)
    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
