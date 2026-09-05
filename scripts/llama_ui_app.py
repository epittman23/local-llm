#!/usr/bin/env python3
"""llama_ui_app.py - the screens of the Textual dashboard.

Part of https://github.com/epittman23/local-llm

Everything here needs Textual, and imports it unguarded. That is deliberate:
`llama_ui.py` is the entry point and holds the promise that a missing Textual
produces an install hint rather than a traceback, and it keeps that promise by
importing this module inside a try. See the "WHY THIS FILE EXISTS SEPARATELY"
paragraph there before merging the two back together.

Two rules this file follows that are easy to break by accident:

1. The shell surface is reached as `shell.profile_names()` through
   `import llama_ui as shell`, never `from llama_ui import profile_names`. The
   lookup has to happen at call time so the headless check can substitute it;
   a from-import binds at import time and cannot be.
2. Every screen shows the shell command equivalent to its current form state.
   Every Button either changes the form (and therefore the command) or runs the
   command shown. Cancel is the one exception -- it is a signal to a running
   command, not a command -- and it says so in its log line.
"""

from __future__ import annotations

import os
import shlex

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.widgets import (Button, DataTable, Footer, Header, Input, Label,
                             Log, Markdown, Select, Static, TabbedContent,
                             TabPane)

import llama_ui as shell
from llama_ui import REPO, Command


class CommandBar(Static):
    """The shell command for the current form state.

    Not decoration. This is the screen's output as much as anything it runs.
    """

    command = reactive("")

    def watch_command(self, value: str) -> None:
        self.update(f"[b]$[/b] {value}" if value else "")


class ShellScreen(VerticalScroll):
    """A screen that runs llama-env.sh commands and tails their output.

    The streaming loop lived twice, once on Serve and once on Tests, differing
    only in the environment, which registry slot the handle went in, and the
    tag written at the end. Those are parameters, so this is one method.
    """

    def run_shell(self, command: str, *, log_id: str, key: str,
                  plain: bool = False, tag: str = "done") -> None:
        self._stream(command, log_id, key, plain, tag)

    @work(thread=True)
    def _stream(self, command: str, log_id: str, key: str, plain: bool,
                tag: str) -> None:
        log = self.query_one(f"#{log_id}", Log)
        job = Command(command, plain=plain)
        job.start()
        self.app.jobs[key] = job
        for line in job.lines():
            self.app.call_from_thread(log.write_line, line)
            self.on_shell_line(line)
        self.app.call_from_thread(log.write_line, f"[{tag}: {job.wait()}]")

    def on_shell_line(self, line: str) -> None:
        """Hook for a screen that reads its subprocess's output. Default: none."""


class ServeScreen(ShellScreen):
    """Start a server from a profile, with the overrides that matter on 6 GB."""

    def compose(self) -> ComposeResult:
        yield Label("Profile")
        yield Select([], id="profile", allow_blank=True)
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
        # The profile list used to be read at module import, which meant
        # importing this module shelled out to bash -- and a failure there was
        # an exception with nowhere to go. Asked for here instead, a failure is
        # a line in the log on a screen that is already up.
        self._profile: dict = {}
        self.load_names()

    @work(thread=True)
    def load_names(self) -> None:
        names = shell.profile_names()
        self.app.call_from_thread(self._set_names, names)

    def _set_names(self, names: list) -> None:
        select = self.query_one("#profile", Select)
        select.set_options([(n, n) for n in names])
        if names:
            select.value = names[0]
            self.load_profile(names[0])

    @work(thread=True)
    def load_profile(self, name: str) -> None:
        """Read the profile off the message pump.

        This is a bash+jq subprocess. It used to be called from
        refresh_command(), which runs on every keystroke across five Inputs, so
        typing an -ot regex spawned a process per character.
        """
        prof = shell.profile_json(name)
        self.app.call_from_thread(self._apply_profile, name, prof)

    def _apply_profile(self, name: str, prof: dict) -> None:
        self._profile = prof
        for field in ("ngl", "ctx", "threads", "parallel", "ot"):
            self.query_one(f"#{field}", Input).value = str(prof.get(field, "") or "")
        # A profile with no reasoning_effort in its flags is not a thinking
        # model, so the control is disabled rather than left offering a value
        # the server would ignore -- and refresh_command skips it while disabled.
        reasoning = self.query_one("#reasoning", Select)
        reasoning.disabled = not prof.get("reasoning")
        if prof.get("reasoning"):
            reasoning.value = str(prof["reasoning"])
        if prof and not prof.get("weights_present", True):
            self.query_one("#serve-log", Log).write_line(
                f"note: {name}'s weights are not on disk "
                f"({prof.get('model', '?')}). llama-fetch {name} downloads them.")
        self.refresh_command()

    def refresh_command(self) -> None:
        prof = self.query_one("#profile", Select).value
        if prof is Select.BLANK:
            return
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
        base = self._profile
        # Only overrides that actually differ from the profile are shown. A
        # command line restating the profile's own defaults would suggest they
        # were choices made here, which is exactly the confusion to avoid.
        for var, value in overrides.items():
            key = var.replace("LLAMA_", "").lower()
            if value and str(value) != str(base.get(key, "")):
                env.append(f"{var}={shlex.quote(str(value))}")
        if self.query_one("#spec", Select).value == "off":
            env.append("LLAMA_SPEC=off")
        prefix = " ".join(env) + " " if env else ""
        self.query_one("#serve-cmd", CommandBar).command = \
            f"{prefix}llama-serve {prof}"

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "profile":
            if event.value is not Select.BLANK:
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
            # Run llama-serve exactly as the shell would, through the same
            # llama-env.sh: the dashboard is a caller of the shell surface,
            # never a reimplementation of it, so telemetry recording and
            # config-id fingerprinting happen identically whether a server was
            # started here or by hand.
            self.run_shell(command, log_id="serve-log", key="serve",
                           tag="server exited")
        elif event.button.id == "stop":
            self.stop_server()
        elif event.button.id == "check":
            self.check_server()

    @work(thread=True, exclusive=True, group="stop")
    def stop_server(self) -> None:
        log = self.query_one("#serve-log", Log)
        job = self.app.jobs.get("serve")
        if job and job.running:
            self.app.call_from_thread(
                log.write_line, "[stopping: SIGTERM to the process group]")
            job.stop()
        else:
            self.app.call_from_thread(
                log.write_line,
                "[no server started from this screen; stop it where it runs]")

    @work(thread=True, exclusive=True, group="check")
    def check_server(self) -> None:
        import subprocess
        log = self.query_one("#serve-log", Log)
        try:
            proc = subprocess.run(["bash", str(shell.ENV_SH), "check"],
                                  capture_output=True, text=True, timeout=15)
            text = (proc.stdout or proc.stderr or "").strip()
        except subprocess.TimeoutExpired:
            text = "[check timed out after 15s; is the port answering?]"
        except OSError as exc:
            text = f"[check failed: {exc}]"
        self.app.call_from_thread(log.write_line, text)


class TestsScreen(ShellScreen):
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
                Select([("none", "")] + [(n, n) for n in shell.system_names()],
                       value="", id="system", allow_blank=False))
        yield CommandBar(id="test-cmd")
        with Horizontal(classes="buttons"):
            yield Button("Run suite", variant="primary", id="run")
            yield Button("Cancel", variant="warning", id="cancel")
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
        log = self.query_one("#test-log", Log)
        if event.button.id == "cancel":
            self.cancel_run()
            return
        command = {
            "run": self.query_one("#test-cmd", CommandBar).command,
            "selfcheck": "llama-test selfcheck",
            "list": "llama-test list",
        }.get(event.button.id)
        if command is None:
            return
        log.write_line(f"$ {command}")
        self.run_shell(command, log_id="test-log", key="tests", plain=True)

    def cancel_run(self) -> None:
        """SIGINT the group, which is the harness's own resumable cancel.

        cmd_suite catches KeyboardInterrupt, reports what it measured and prints
        the resume line, so this produces a clean stop rather than a killed
        process and a half-written suite. The log line keeps the shell
        equivalence the rest of the screen keeps: this is the one button that
        signals a command instead of running one, so it says which signal.
        """
        log = self.query_one("#test-log", Log)
        job = self.app.jobs.get("tests")
        if job and job.running and job.interrupt():
            log.write_line("[SIGINT to llama-test; it will print how far it "
                           "got and the --resume line to continue]")
        else:
            log.write_line("[nothing running]")


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
        conn = shell.reader()
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
            (out / f"{name}.md").write_text(llama_test._answer_document(answer))
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
        conn = shell.reader()

        if by == "serving":
            # The serving view answers a question that does not need a test
            # run -- how fast this configuration was, and how much VRAM it had
            # left -- so it deliberately skips the "no results yet" guard below.
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

        records = store.read_all(conn, tier=str(tier) if tier else None)
        if not records:
            log.clear()
            log.write_line("No test results yet. Run a suite on the Tests tab.")
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
        conn = shell.reader()

        rows = db.runs(conn, limit=1, active_only=True) or db.runs(conn, limit=1)
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
        self.rows = []
        self.query_one("#ans-table", DataTable).cursor_type = "row"
        self.load_runs()

    # -- the run picker ----------------------------------------------------
    def load_runs(self) -> None:
        import llama_db as db

        runs = db.suite_runs(shell.reader())
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

        records = [r for r in db.results(shell.reader())
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
        answer = db.answer_for(shell.reader(), benchmark, item_id,
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
    CSS_PATH = "llama_ui.tcss"
    BINDINGS = [("q", "quit", "Quit"), ("r", "refresh", "Refresh")]
    TITLE = "local-llm"
    SUB_TITLE = "serve, test, compare"

    def __init__(self, *, initial_tab: str = "tests"):
        super().__init__()
        self.initial_tab = initial_tab
        # Every subprocess this app owns, so quitting can stop all of them and
        # each screen can find the one it started.
        self.jobs: dict[str, Command] = {}

    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent(initial=self.initial_tab):
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

    def on_mount(self) -> None:
        shell.open_store()

    def action_refresh(self) -> None:
        for screen in self.query(CompareScreen):
            screen.reload()
        for screen in self.query(LiveScreen):
            screen.reload()
        for screen in self.query(AnswersScreen):
            screen.load_runs()

    def stop_jobs(self) -> None:
        """Stop every subprocess this app started. Safe to call twice."""
        for job in list(self.jobs.values()):
            if job.running:
                job.stop()

    def on_unmount(self) -> None:
        self.stop_jobs()
