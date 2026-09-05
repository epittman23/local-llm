#!/usr/bin/env python3
"""llama_ui.py - the Textual dashboard over serving, testing and comparison.

Part of https://github.com/epittman23/local-llm

Reached as `llama-ui` or `llama-test ui`. Five screens, one per thing this
project actually does: start a server, watch what it is doing, run a graded
suite against it, compare what came back, and read what it actually said.

The Live screen exists only because the samples are in a database now. Under
the markdown store a run's GPU telemetry accumulated in a tmpfile and was
folded into the log by an EXIT trap, so there was nothing to read until the
server stopped -- which is the moment the numbers stop being useful.

THE POINT OF THIS FILE, and the reason to read it before changing it: every
screen shows the shell command equivalent to its current form state, updated as
the form changes. The ask it answers is "so I don't have to remember all the
flags" -- and a dashboard that hid the flags would answer it only while the
dashboard was open. Showing the command means the form is a way to *learn* the
flags, and anything done here can be redone, scripted, or pasted into a
decisions-log entry afterwards.

Serving configuration is not defined here. The profile fields are read from
`llama-env.sh profile-json`, which keeps that file the single source of truth
(CLAUDE.md) instead of creating a second profile table that would drift.

Textual is an optional dependency. Without it this exits with the command to
install it rather than a traceback, and every other entry point keeps working.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"

try:
    from textual import work
    from textual.app import App, ComposeResult
    from textual.containers import Horizontal, Vertical, VerticalScroll
    from textual.reactive import reactive
    from textual.widgets import (Button, DataTable, Footer, Header, Input,
                                 Label, Log, Markdown, Select, Static,
                                 TabbedContent, TabPane)
except ImportError:                       # pragma: no cover - optional dependency
    App = None


def profile_names() -> list:
    """The defined profiles, read from llama-env.sh (the source of truth)."""
    try:
        proc = subprocess.run([("bash"), str(ENV_SH), "profile-names"],
                              capture_output=True, text=True, timeout=30)
        names = [n for n in proc.stdout.split() if n]
        if proc.returncode == 0 and names:
            return names
    except (OSError, subprocess.SubprocessError):
        pass
    return ["qwen38"]


PROFILES = profile_names()

SYSTEM_DIR = ENV_SH.parent.parent / "prompts" / "system"


def system_names() -> list:
    """The named system prompts on disk, so the picker cannot list a stale set."""
    if not SYSTEM_DIR.is_dir():
        return []
    return sorted(p.stem for p in SYSTEM_DIR.glob("*.txt"))


def profile_json(name: str) -> dict:
    try:
        proc = subprocess.run([("bash"), str(ENV_SH), "profile-json", name],
                              capture_output=True, text=True, timeout=30)
        if proc.returncode == 0:
            return json.loads(proc.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return {}


class CommandBar(Static):
    """The shell command for the current form state.

    Not decoration. This is the screen's output as much as anything it runs.
    """

    command = reactive("")

    def watch_command(self, value: str) -> None:
        self.update(f"[b]$[/b] {value}" if value else "")


class ServeScreen(VerticalScroll):
    """Start a server from a profile, with the overrides that matter on 6 GB."""

    def compose(self) -> ComposeResult:
        yield Label("Profile")
        yield Select([(p, p) for p in PROFILES], value=PROFILES[0], id="profile",
                     allow_blank=False)
        with Horizontal(classes="fields"):
            yield Vertical(Label("-ngl"), Input(id="ngl"))
            yield Vertical(Label("context"), Input(id="ctx"))
            yield Vertical(Label("threads"), Input(id="threads"))
            yield Vertical(Label("--parallel"), Input(id="parallel"))
        yield Label("-ot (tensor overrides)")
        yield Input(id="ot")
        yield Label("speculative decoding")
        yield Select([("profile default", "on"), ("off (LLAMA_SPEC=off)", "off")],
                     value="on", id="spec", allow_blank=False)
        yield Label("reasoning effort")
        yield Select([(e, e) for e in ("low", "medium", "high", "xhigh")],
                     value="medium", id="reasoning", allow_blank=False)
        with Horizontal(classes="buttons"):
            yield Button("Start server", variant="primary", id="start")
            yield Button("Stop", variant="warning", id="stop")
            yield Button("Check", id="check")
        yield CommandBar(id="serve-cmd")
        yield Log(id="serve-log", highlight=True)

    def on_mount(self) -> None:
        self.load_profile(PROFILES[0])

    def load_profile(self, name: str) -> None:
        prof = profile_json(name)
        for field, key in (("ngl", "ngl"), ("ctx", "ctx"),
                           ("threads", "threads"), ("parallel", "parallel"),
                           ("ot", "ot")):
            self.query_one(f"#{field}", Input).value = str(prof.get(key, "") or "")
        # A profile with no reasoning_effort in its flags is not a thinking
        # model, so the control is disabled rather than left offering a value
        # the server would ignore -- and refresh_command skips it while disabled.
        reasoning = self.query_one("#reasoning", Select)
        reasoning.disabled = not prof.get("reasoning")
        if prof.get("reasoning"):
            reasoning.value = str(prof["reasoning"])
        if not prof.get("weights_present", True):
            self.query_one("#serve-log", Log).write_line(
                f"note: {name}'s weights are not on disk "
                f"({prof.get('model', '?')}). llama-fetch {name} downloads them.")
        self.refresh_command()

    def refresh_command(self) -> None:
        prof = self.query_one("#profile", Select).value
        env, overrides = [], {
            "LLAMA_NGL": self.query_one("#ngl", Input).value,
            "LLAMA_CTX": self.query_one("#ctx", Input).value,
            "LLAMA_THREADS": self.query_one("#threads", Input).value,
            "LLAMA_PARALLEL": self.query_one("#parallel", Input).value,
            "LLAMA_OT": self.query_one("#ot", Input).value,
        }
        reasoning = self.query_one("#reasoning", Select)
        if not reasoning.disabled:
            overrides["LLAMA_REASONING"] = reasoning.value
        base = profile_json(str(prof))
        # Only overrides that actually differ from the profile are shown. A
        # command line restating the profile's own defaults would suggest they
        # were choices made here, which is exactly the confusion to avoid.
        for var, value in overrides.items():
            key = var.replace("LLAMA_", "").lower()
            key = {"ctx": "ctx", "ngl": "ngl", "threads": "threads",
                   "parallel": "parallel", "ot": "ot",
                   "reasoning": "reasoning"}[key]
            if value and str(value) != str(base.get(key, "")):
                env.append(f"{var}={shlex.quote(str(value))}")
        if self.query_one("#spec", Select).value == "off":
            env.append("LLAMA_SPEC=off")
        prefix = " ".join(env) + " " if env else ""
        self.query_one("#serve-cmd", CommandBar).command = \
            f"{prefix}llama-serve {prof}"

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "profile":
            self.load_profile(str(event.value))
        else:
            self.refresh_command()

    def on_input_changed(self, event: Input.Changed) -> None:
        self.refresh_command()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        log = self.query_one("#serve-log", Log)
        if event.button.id == "start":
            command = self.query_one("#serve-cmd", CommandBar).command
            log.write_line(f"$ {command}")
            self.start_server(command)
        elif event.button.id == "stop":
            self.stop_server()
        elif event.button.id == "check":
            self.check_server()

    @work(thread=True, exclusive=True, group="serve")
    def start_server(self, command: str) -> None:
        """Run llama-serve exactly as the shell would, and tail its output.

        The command is the one on screen, run through the same llama-env.sh:
        the dashboard is a caller of the shell surface, never a reimplementation
        of it, so telemetry recording and config-id fingerprinting happen
        identically whether a server was started here or by hand.
        """
        log = self.query_one("#serve-log", Log)
        proc = subprocess.Popen(
            ["bash", "-c", f"source {shlex.quote(str(ENV_SH))} && {command}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1)
        self.app.server_proc = proc
        for line in proc.stdout:
            self.app.call_from_thread(log.write_line, line.rstrip())
        self.app.call_from_thread(log.write_line,
                                  f"[server exited: {proc.wait()}]")

    @work(thread=True, group="stop")
    def stop_server(self) -> None:
        log = self.query_one("#serve-log", Log)
        proc = getattr(self.app, "server_proc", None)
        if proc and proc.poll() is None:
            proc.terminate()
            self.app.call_from_thread(log.write_line, "[stopping]")
        else:
            self.app.call_from_thread(
                log.write_line,
                "[no server started from this screen; stop it where it runs]")

    @work(thread=True, group="check")
    def check_server(self) -> None:
        log = self.query_one("#serve-log", Log)
        proc = subprocess.run(["bash", str(ENV_SH), "check"],
                              capture_output=True, text=True, timeout=15)
        self.app.call_from_thread(
            log.write_line, (proc.stdout or proc.stderr or "").strip())


class TestsScreen(VerticalScroll):
    """Run a tier or a single item, and watch the results land."""

    def compose(self) -> ComposeResult:
        with Horizontal(classes="fields"):
            yield Vertical(
                Label("tier"),
                Select([(t, t) for t in ("smoke", "standard", "full")],
                       value="smoke", id="tier", allow_blank=False))
            yield Vertical(
                Label("benchmark"),
                Select([("all", ""), ("humaneval", "humaneval"),
                        ("mbpp", "mbpp"), ("ds1000", "ds1000")],
                       value="", id="tbench", allow_blank=False))
            yield Vertical(Label("resume"),
                           Select([("no", ""), ("yes", "--resume")],
                                  value="", id="resume", allow_blank=False))
            # "none" is a real choice, not an absent one: a run without a system
            # prompt is the baseline every run with one is measured against.
            yield Vertical(
                Label("system prompt"),
                Select([("none", "")] + [(n, n) for n in system_names()],
                       value="", id="system", allow_blank=False))
        yield CommandBar(id="test-cmd")
        with Horizontal(classes="buttons"):
            yield Button("Run suite", variant="primary", id="run")
            yield Button("Self-check graders", id="selfcheck")
            yield Button("List benchmarks", id="list")
        yield Log(id="test-log", highlight=True)

    def on_mount(self) -> None:
        self.refresh_command()

    def refresh_command(self) -> None:
        tier = self.query_one("#tier", Select).value
        bench = self.query_one("#tbench", Select).value
        resume = self.query_one("#resume", Select).value
        system = self.query_one("#system", Select).value
        parts = ["llama-test", "--suite", str(tier)]
        if bench:
            parts += ["--benchmark", str(bench)]
        if system:
            parts += ["--system", str(system)]
        if resume:
            parts.append(str(resume))
        self.query_one("#test-cmd", CommandBar).command = " ".join(parts)

    def on_select_changed(self, event: Select.Changed) -> None:
        self.refresh_command()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "run":
            self.run_command(self.query_one("#test-cmd", CommandBar).command)
        elif event.button.id == "selfcheck":
            self.run_command("llama-test selfcheck")
        elif event.button.id == "list":
            self.run_command("llama-test list")

    @work(thread=True, exclusive=True, group="tests")
    def run_command(self, command: str) -> None:
        log = self.query_one("#test-log", Log)
        self.app.call_from_thread(log.write_line, f"$ {command}")
        # LLAMA_PLAIN because the output is going into a Log widget, which does
        # its own rendering; Rich's escape codes would be shown, not applied.
        env = dict(os.environ, LLAMA_PLAIN="1")
        proc = subprocess.Popen(
            ["bash", "-c", f"source {shlex.quote(str(ENV_SH))} && {command}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1, env=env)
        for line in proc.stdout:
            self.app.call_from_thread(log.write_line, line.rstrip())
        self.app.call_from_thread(log.write_line, f"[done: {proc.wait()}]")


class CompareScreen(VerticalScroll):
    """The comparison table, from logs/llama.db.

    Reads through llama_compare rather than reimplementing the table, so the
    caveats, the counts-beside-every-rate rule and the ranking are the same
    ones `llama-test compare` prints. A second implementation here would be a
    second place for those rules to be got wrong.
    """

    def compose(self) -> ComposeResult:
        with Horizontal(classes="fields"):
            yield Vertical(Label("group by"),
                           Select([("configuration", "config"),
                                   ("benchmark", "benchmark"),
                                   ("failures", "failures"),
                                   ("serving", "serving")],
                                  value="config", id="by", allow_blank=False))
            yield Vertical(Label("tier"),
                           Select([("all", ""), ("smoke", "smoke"),
                                   ("standard", "standard"), ("full", "full")],
                                  value="", id="ctier", allow_blank=False))
        yield CommandBar(id="cmp-cmd")
        with Horizontal(classes="buttons"):
            yield Button("Refresh", variant="primary", id="refresh")
            yield Button("Export answers", id="export")
        yield DataTable(id="cmp-table")
        yield Log(id="cmp-log", highlight=True)

    def on_mount(self) -> None:
        self.refresh_command()
        self.reload()

    def refresh_command(self) -> None:
        parts = ["llama-test", "compare", "--by",
                 str(self.query_one("#by", Select).value)]
        tier = self.query_one("#ctier", Select).value
        if tier:
            parts += ["--tier", str(tier)]
        self.query_one("#cmp-cmd", CommandBar).command = " ".join(parts)

    def on_select_changed(self, event: Select.Changed) -> None:
        self.refresh_command()
        self.reload()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "refresh":
            self.reload()
        elif event.button.id == "export":
            # There is no report file to rebuild any more. The answers are in
            # the database; this writes the old logs/answers/<run>/ layout out
            # of it for anyone who wants to read them with an editor.
            self.export_answers()

    def export_answers(self) -> None:
        import llama_db as db
        import llama_results as store
        import llama_test

        log = self.query_one("#cmp-log", Log)
        with closing(db.connect()) as conn:
            run = store.latest_run(conn)
            if not run:
                log.write_line("nothing recorded to export")
                return
            out = REPO / "logs" / "answers" / run
            out.mkdir(parents=True, exist_ok=True)
            written = 0
            for r in db.results(conn):
                if r["suite_run_id"] != run:
                    continue
                answer = db.answer_for(conn, r["benchmark"], r["item_id"], run)
                if not answer:
                    continue
                name = f"{r['benchmark']}_{r['item_id']}".replace("/", "_")
                (out / f"{name}.md").write_text(
                    llama_test._answer_document(answer))
                written += 1
        log.write_line(f"exported {written} answers to {out}")

    def reload(self) -> None:
        import llama_compare
        import llama_db as db
        import llama_results as store

        table = self.query_one("#cmp-table", DataTable)
        table.clear(columns=True)
        log = self.query_one("#cmp-log", Log)
        tier = self.query_one("#ctier", Select).value
        by = self.query_one("#by", Select).value

        if by == "serving":
            # The serving view answers a question that does not need a test
            # run -- how fast this configuration was, and how much VRAM it had
            # left -- so it deliberately skips the "no results yet" guard below.
            with closing(db.connect()) as conn:
                rows, derived, notes = llama_compare.serving_rows(conn)
            log.clear()
            if not rows:
                log.write_line("No serving runs recorded yet.")
                return
            table.add_columns(*llama_compare.SERVING_COLUMNS)
            for row in rows:
                table.add_row(*[str(c) for c in row])
            for row in derived:
                log.write_line(" | ".join(str(c) for c in row))
            for note in notes:
                log.write_line(note.lstrip("> "))
            return

        with closing(db.connect()) as conn:
            records = store.read_all(conn, tier=str(tier) if tier else None)
            if not records:
                log.clear()
                log.write_line(
                    "No test results yet. Run a suite on the Tests tab.")
                return
            groups = llama_compare.group_records(records)
            # One query against the config table, where this used to glob
            # logs/*.log and parse every markdown block in every file.
            blocks = db.configs(conn)
            notes = (llama_compare.caveats(groups, blocks)
                     + llama_compare.exclusion_note(conn))

        if by == "benchmark":
            columns, rows = llama_compare.benchmark_rows(groups)
        elif by == "failures":
            columns, rows = llama_compare.failure_rows(groups)
            notes = []
        else:
            columns = llama_compare.COLUMNS
            rows = llama_compare.rows_for(groups, blocks)
        table.add_columns(*columns)
        for row in rows:
            table.add_row(*[str(c) for c in row])

        log.clear()
        for note in notes:
            log.write_line(note.lstrip("> "))


class LiveScreen(VerticalScroll):
    """The run that is serving right now, as it is being recorded.

    Every figure here is derived from stored rows at the moment it is drawn --
    llama_stats.gpu_stats over the samples, llama_db.metrics_delta over the
    /metrics scrapes -- so it is the same arithmetic a summary of the finished
    run will use, not a parallel estimate that could disagree with it.
    """

    REFRESH_SECONDS = 5.0

    def compose(self) -> ComposeResult:
        yield Static("", id="live-run")
        with Horizontal(classes="buttons"):
            yield Button("Refresh", variant="primary", id="live-refresh")
        yield DataTable(id="live-stats")
        yield Label("recent samples")
        yield DataTable(id="live-samples")
        yield Log(id="live-log", highlight=True)

    def on_mount(self) -> None:
        self.reload()
        # Matched to the recorder's own default sampling interval: polling
        # faster than samples arrive would redraw the same rows.
        self.set_interval(self.REFRESH_SECONDS, self.reload)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "live-refresh":
            self.reload()

    def reload(self) -> None:
        import llama_db as db
        import llama_stats as stats

        header = self.query_one("#live-run", Static)
        table = self.query_one("#live-stats", DataTable)
        recent = self.query_one("#live-samples", DataTable)
        log = self.query_one("#live-log", Log)

        with closing(db.connect()) as conn:
            rows = db.runs(conn, limit=1, active_only=True) or \
                db.runs(conn, limit=1)
            if not rows:
                header.update("No serving run recorded yet. "
                              "Start one on the Serve tab.")
                table.clear(columns=True)
                recent.clear(columns=True)
                return
            run = rows[0]
            samples = db.samples(conn, run["run_id"])
            summary = stats.gpu_stats(samples)
            deltas = db.metrics_delta(conn, run["run_id"])
            requests = db.request_count(conn, run["run_id"])
            headroom = summary.get("vram_headroom_mib")
            warning = stats.headroom_warning(
                f"run {run['run_id']}", headroom) if samples else None

        state = "serving" if run.get("ended_at") is None else \
            f"ended {run['ended_at']} ({run.get('ended_reason') or 'clean'})"
        header.update(
            f"{run['model']}-{run['quant']}  config {run['config_id']}  "
            f"build {run['build']}  port {run['port']}\n"
            f"started {run['started_at']}  {state}  "
            f"{len(samples)} samples  {requests} requests")

        table.clear(columns=True)
        table.add_columns("statistic", "value")
        for key in ("util_active_avg", "util_p50", "util_p95", "util_max",
                    "temp_max", "power_p50", "power_p95", "sm_p50", "sm_max",
                    "mem_max", "vram_headroom_mib", "throttle"):
            value = summary.get(key)
            if value is None or value == "":
                continue
            table.add_row(key.replace("_", " "),
                          f"{value:.1f}" if isinstance(value, float)
                          else str(value))
        for counter, value in sorted(deltas.items()):
            table.add_row(counter.replace("llamacpp:", ""), f"{value:.0f}")

        recent.clear(columns=True)
        recent.add_columns("at", "util %", "mem MiB", "power W", "SM MHz",
                           "temp C")
        for s in samples[-12:]:
            recent.add_row(str(s.get("at", ""))[11:19],
                           str(s.get("util_pct", "")),
                           str(s.get("mem_used_mib", "")),
                           str(s.get("power_w", "")),
                           str(s.get("sm_mhz", "")),
                           str(s.get("temp_c", "")))

        log.clear()
        if warning:
            log.write_line(warning.lstrip("> "))


class AnswersScreen(VerticalScroll):
    """What the model actually said, for one recorded item.

    The pairing for `compare --by failures`: that view names the items worth
    looking at and this one shows them, which is the step that used to mean
    finding a file under logs/answers/ and opening it in an editor.

    Rendering is the point rather than a flourish. A response is markdown with
    fenced code in it, and read as plain text the code is the part that suffers
    most -- so it goes through the same document llama-test answer prints, in
    its collapse=False form, because a <details> block is meaningless in a
    terminal and Textual's Markdown drops raw HTML anyway.

    The thinking is off by default and is not a display preference. Reasoning
    dominates the token budget on this model, so a trace is routinely tens of
    thousands of characters; parsing that into a Markdown widget on every row
    change would make the table feel broken. It is also never graded, so it is
    not what you came to look at -- the response is.
    """

    def compose(self) -> ComposeResult:
        with Horizontal(classes="fields"):
            yield Vertical(Label("suite run"),
                           Select([], id="ans-run", allow_blank=True))
            yield Vertical(Label("show"),
                           Select([("failures", "failures"),
                                   ("all items", "all"),
                                   ("passes", "pass")],
                                  value="failures", id="ans-filter",
                                  allow_blank=False))
        yield CommandBar(id="ans-cmd")
        with Horizontal(classes="buttons"):
            yield Button("Refresh", variant="primary", id="ans-refresh")
            yield Button("Show thinking", id="ans-think")
        yield DataTable(id="ans-table")
        yield VerticalScroll(Markdown("", id="ans-md"), id="ans-body")

    def on_mount(self) -> None:
        self.show_reasoning = False
        self.current = None
        self.query_one("#ans-table", DataTable).cursor_type = "row"
        self.load_runs()

    # -- the run picker ----------------------------------------------------
    def load_runs(self) -> None:
        import llama_db as db

        with closing(db.connect()) as conn:
            runs = db.suite_runs(conn)
        select = self.query_one("#ans-run", Select)
        options = [(f"{r['started_at'][:19]}  {r['model']}  {r['tier']}  "
                    f"{r['passed']}/{r['attempted']}", r["suite_run_id"])
                   for r in runs]
        select.set_options(options)
        if options:
            select.value = options[0][1]
        self.reload()

    def on_select_changed(self, event: Select.Changed) -> None:
        self.reload()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "ans-refresh":
            self.load_runs()
        elif event.button.id == "ans-think":
            self.show_reasoning = not self.show_reasoning
            event.button.label = ("Hide thinking" if self.show_reasoning
                                  else "Show thinking")
            self.show_answer()

    # -- the item list -----------------------------------------------------
    def reload(self) -> None:
        import llama_db as db
        import llama_results as store

        table = self.query_one("#ans-table", DataTable)
        table.clear(columns=True)
        table.add_columns("benchmark", "item", "outcome", "why", "thinking")
        run = self.query_one("#ans-run", Select).value
        wanted_ = self.query_one("#ans-filter", Select).value
        self.rows = []
        if run in (None, Select.BLANK):
            self.query_one("#ans-md", Markdown).update(
                "No suite run recorded yet. Run one on the Tests tab.")
            self.refresh_command()
            return

        with closing(db.connect()) as conn:
            records = [r for r in db.results(conn)
                       if r["suite_run_id"] == run]
        for r in records:
            outcome = r.get("outcome")
            if wanted_ == "failures" and outcome not in store.FAILURES:
                continue
            if wanted_ == "pass" and outcome != store.PASS:
                continue
            if outcome == store.SKIPPED:
                continue
            self.rows.append((r["benchmark"], r["item_id"]))
            chars = r.get("reasoning_chars")
            table.add_row(r["benchmark"], r["item_id"], str(outcome),
                          (r.get("reason") or "")[:60],
                          "" if chars is None else f"{chars:,}")

        if self.rows:
            self.current = self.rows[0]
            self.show_answer()
        else:
            self.current = None
            self.query_one("#ans-md", Markdown).update(
                f"Nothing matching `{wanted_}` in this run.")
        self.refresh_command()

    def on_data_table_row_highlighted(self, event) -> None:
        index = getattr(event, "cursor_row", None)
        if index is None or not (0 <= index < len(self.rows)):
            return
        self.current = self.rows[index]
        self.show_answer()
        self.refresh_command()

    # -- the answer --------------------------------------------------------
    def show_answer(self) -> None:
        import llama_db as db
        import llama_test

        body = self.query_one("#ans-md", Markdown)
        if not self.current:
            return
        benchmark, item_id = self.current
        run = self.query_one("#ans-run", Select).value
        with closing(db.connect()) as conn:
            answer = db.answer_for(conn, benchmark, item_id,
                                   None if run is Select.BLANK else str(run))
        if not answer:
            body.update(f"No stored answer for `{benchmark}/{item_id}`.")
            return
        if not self.show_reasoning:
            # Dropped from the copy rather than the row, so nothing that reads
            # this record afterwards sees a truncated one.
            answer = dict(answer, reasoning="")
        body.update(llama_test._answer_document(answer, collapse=False))

    def refresh_command(self) -> None:
        """The `llama-test answer` invocation for the highlighted row.

        Same rule as every other screen here: the dashboard shows the command,
        so the flags are learnable rather than hidden behind a form.
        """
        run = self.query_one("#ans-run", Select).value
        if not self.current:
            self.query_one("#ans-cmd", CommandBar).command = ""
            return
        benchmark, item_id = self.current
        parts = ["llama-test", "answer", f"{benchmark}/{item_id}"]
        if run not in (None, Select.BLANK):
            parts += ["--run-id", str(run)]
        self.query_one("#ans-cmd", CommandBar).command = " ".join(parts)


class LlamaApp(App):
    CSS = """
    .fields { height: auto; }
    .fields > Vertical { width: 1fr; height: auto; padding: 0 1; }
    .buttons { height: auto; padding: 1 0; }
    .buttons > Button { margin-right: 1; }
    CommandBar {
        background: $panel; color: $text; padding: 1;
        border: round $primary; margin: 1 0;
    }
    Log { height: 1fr; min-height: 10; border: round $panel; }
    DataTable { height: auto; max-height: 20; }
    #ans-body { height: 1fr; min-height: 20; border: round $panel; padding: 0 1; }
    #ans-table { max-height: 12; }
    """
    BINDINGS = [("q", "quit", "Quit"), ("r", "refresh", "Refresh")]
    TITLE = "local-llm"
    SUB_TITLE = "serve, test, compare"

    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent(initial="tests"):
            with TabPane("Serve", id="serve"):
                yield ServeScreen()
            with TabPane("Live", id="live"):
                yield LiveScreen()
            with TabPane("Tests", id="tests"):
                yield TestsScreen()
            with TabPane("Compare", id="compare"):
                yield CompareScreen()
            with TabPane("Answers", id="answers"):
                yield AnswersScreen()
        yield Footer()

    def action_refresh(self) -> None:
        for screen in self.query(CompareScreen):
            screen.reload()
        for screen in self.query(LiveScreen):
            screen.reload()
        for screen in self.query(AnswersScreen):
            screen.load_runs()

    def on_unmount(self) -> None:
        proc = getattr(self, "server_proc", None)
        if proc and proc.poll() is None:
            proc.terminate()


def main(argv: list[str] | None = None) -> int:
    if App is None:
        raise SystemExit(
            "llama-ui: this needs textual, which is not installed.\n"
            f"  {REPO}/.venv/bin/pip install -r {REPO}/requirements.txt\n"
            "  (or run any llama-test command, which bootstraps the venv)")
    LlamaApp().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
