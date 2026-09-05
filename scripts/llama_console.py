#!/usr/bin/env python3
"""llama_console.py - Rich when it is installed and wanted, plain text otherwise.

Part of https://github.com/epittman23/local-llm

Every entry point in this repo has to keep working without Rich. The telemetry
recorder runs with bare `python3` for the life of every server (see
llama-vram-log.sh), a piped `llama-test ... > answer.md` must contain the answer
and nothing else, and the venv may simply not have been created yet. So all Rich
use goes through here, and here decides once:

  * stdout is not a TTY   -> plain, because the output is being captured
  * NO_COLOR / LLAMA_PLAIN -> plain, because the user said so
  * rich is not installed  -> plain, because there is no alternative

The plain path is not a degraded stub -- it prints the same tables in the
markdown style llama_stats.render_table writes, which is what `--format
markdown` produces for pasting a measured table into README.md.
"""

from __future__ import annotations

import os
import sys

try:                                    # pragma: no cover - environment dependent
    import rich
    from rich.console import Console
    from rich.table import Table
    from rich.text import Text
    HAVE_RICH = True
except ImportError:                     # pragma: no cover - environment dependent
    HAVE_RICH = False


def wanted(stream=None) -> bool:
    """Whether to render richly to this stream."""
    if not HAVE_RICH:
        return False
    if os.environ.get("LLAMA_PLAIN") or os.environ.get("NO_COLOR"):
        return False
    stream = stream or sys.stdout
    try:
        return stream.isatty()
    except (AttributeError, ValueError):
        return False


class Console_:
    """The one console. Writes to stderr by default.

    stderr, not stdout, because llama-test's contract is that stdout carries the
    model's answer alone; progress, tables and warnings are commentary and belong
    beside it, not in it.
    """

    def __init__(self, stream=None):
        self.stream = stream or sys.stderr
        self.rich = wanted(self.stream)
        self._c = Console(file=self.stream, soft_wrap=True) if self.rich else None

    # -- plain-safe primitives ---------------------------------------------
    def out(self, text: str = "") -> None:
        print(text, file=self.stream, flush=True)

    def say(self, text: str, style: str = "") -> None:
        if self.rich:
            self._c.print(Text(text, style=style) if style else text)
        else:
            self.out(text)

    def rule(self, title: str = "") -> None:
        if self.rich:
            self._c.rule(title)
        else:
            self.out(f"\n== {title}" if title else "")

    def note(self, text: str) -> None:
        self.say(text, "dim")

    def warn(self, text: str) -> None:
        self.say(f"warning: {text}", "yellow")

    def error(self, text: str) -> None:
        self.say(f"error: {text}", "bold red")

    def ok(self, text: str) -> None:
        self.say(text, "green")

    # -- tables ------------------------------------------------------------
    def table(self, headers: list[str], rows: list[list], title: str = "",
              styles: dict[int, str] | None = None) -> None:
        """Render a table. Plain output is the markdown llama_stats writes."""
        rows = [[("" if c is None else str(c)) for c in row] for row in rows]
        if not self.rich:
            if title:
                self.out(f"\n{title}")
            self.out(render_markdown_table(headers, rows))
            return
        table = Table(title=title or None, header_style="bold cyan",
                      title_style="bold", show_edge=False, pad_edge=False)
        for i, head in enumerate(headers):
            # Numbers right-align; everything else keeps its shape.
            numeric = all(_looks_numeric(r[i]) for r in rows) if rows else False
            table.add_column(head, justify="right" if numeric else "left",
                             style=(styles or {}).get(i, ""), overflow="fold")
        for row in rows:
            table.add_row(*row)
        self._c.print(table)

    def status(self, text: str):
        """A spinner when rich is available, a printed line when it is not."""
        if self.rich:
            return self._c.status(text)
        self.note(text)
        return _NullContext()


class _NullContext:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def update(self, *args, **kwargs):
        pass


def _looks_numeric(cell: str) -> bool:
    cell = cell.strip().rstrip("%*")
    if not cell or cell in {"-", "n/a"}:
        return True
    try:
        float(cell.replace(",", ""))
        return True
    except ValueError:
        return False


def render_markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    """The same table shape llama_stats.render_table produces.

    Reimplemented rather than imported so this module stays usable when
    llama_stats.py is not importable, which is the situation it exists for.
    """
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    def line(cells):
        return "| " + " | ".join(str(c).ljust(widths[i])
                                 for i, c in enumerate(cells)) + " |"
    out = [line(headers), "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
    out += [line(r) for r in rows]
    return "\n".join(out)


CONSOLE: Console_ | None = None


def console(stream=None) -> Console_:
    """The process-wide console."""
    global CONSOLE
    if CONSOLE is None or stream is not None:
        CONSOLE = Console_(stream)
    return CONSOLE


def require(module: str, hint: str) -> None:
    """Exit with an actionable message when an optional dependency is missing."""
    raise SystemExit(
        f"llama-test: this needs {module}, which is not installed.\n"
        f"  {hint}")


def write_markdown(text: str, stream=None) -> bool:
    """Write a markdown document, rendered if the stream is an interactive TTY.

    Returns True when it was rendered, False when it was written verbatim, so a
    caller can adjust what it hands over (the answer document drops its
    <details> wrapper when it knows a terminal will read it, since nothing in a
    terminal can expand one).

    This is the one place Rich is allowed to touch **stdout**. Console_ writes
    to stderr on purpose, and rendering would be actively wrong here for a
    redirected stream: Rich reflows paragraphs and pads code blocks, so
    `llama-test answer ... > answer.md` would capture a prettified transcript
    instead of the document. wanted() already answers that question -- not a
    TTY, or NO_COLOR/LLAMA_PLAIN, or no Rich, means raw -- so the guard is the
    same one every other output path in this repo uses.
    """
    stream = stream or sys.stdout
    if not wanted(stream):
        stream.write(text)
        return False
    from rich.console import Console as _Console
    from rich.markdown import Markdown
    # code_theme matches the tables: readable on both light and dark terminals.
    _Console(file=stream).print(Markdown(text, code_theme="ansi_dark"))
    return True


# ---------------------------------------------------------------------------
# Diagnostics rendering
#
# llama-profiles, llama-check and llama-vram call in here so their output looks
# like every other table in this project. Each keeps a plain fallback in the
# shell, so the diagnostics still work when Python or the venv is unavailable --
# which is exactly the situation someone runs diagnostics in.
# ---------------------------------------------------------------------------
def _env_sh():
    from pathlib import Path
    return Path(__file__).resolve().parent / "llama-env.sh"


def _profile_names():
    """The defined profiles, asked of the shell rather than listed here.

    scripts/llama-env.sh is the single source of truth for serving
    configuration, profile names included; a copy in Python would be wrong the
    first time a profile was added there. The fallback covers the case this
    whole module is a fallback for -- something is broken enough that the shell
    call failed -- and names the default profile only, since that is the one a
    reader needs to get a server up.
    """
    import subprocess
    try:
        proc = subprocess.run(["bash", str(_env_sh()), "profile-names"],
                              capture_output=True, text=True, timeout=30)
        names = [n for n in proc.stdout.split() if n]
        if proc.returncode == 0 and names:
            return names
    except (OSError, subprocess.SubprocessError):
        pass
    return ["qwen38"]


def cmd_profiles(argv) -> int:
    import json
    import subprocess
    con = console()
    rows = []
    for name in _profile_names():
        try:
            proc = subprocess.run(["bash", str(_env_sh()), "profile-json", name],
                                  capture_output=True, text=True, timeout=30)
            prof = json.loads(proc.stdout) if proc.returncode == 0 else {}
        except (OSError, ValueError, subprocess.SubprocessError):
            prof = {}
        if not prof:
            rows.append([name, "?", "unreadable", "", "", "", ""])
            continue
        rows.append([
            prof.get("name", name), prof.get("arch", "?"),
            "present" if prof.get("weights_present") else "missing",
            str(prof.get("ngl", "")), str(prof.get("ctx", "")),
            str(prof.get("parallel", "")),
            "on" if prof.get("spec") else "off",
        ])
    con.table(["profile", "arch", "weights", "ngl", "context", "parallel",
               "spec"], rows, title="serving profiles")
    con.note("weights: llama-fetch <profile>   |   serve: llama-serve <profile>")
    return 0


def cmd_check(argv) -> int:
    import json
    import os
    import urllib.error
    import urllib.request
    con = console()
    port = os.environ.get("LLAMA_PORT", "8090")
    try:
        with urllib.request.urlopen(
                f"http://localhost:{port}/v1/models", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        con.error(f"no server responding on port {port} ({exc})")
        con.note("start one with: llama-serve qwen38")
        return 1
    rows = [[m.get("id", "?"), str(m.get("owned_by", "")),
             str(m.get("created", ""))] for m in data.get("data", [])]
    con.table(["model", "owned by", "created"], rows,
              title=f"serving on port {port}")
    return 0


def cmd_vram(argv) -> int:
    """A live GPU gauge, replacing `watch nvidia-smi`.

    Refreshes in place rather than reprinting, and shows free VRAM prominently:
    on a 6 GB card the number that decides whether an -ngl setting is viable is
    the headroom, not the utilization.
    """
    import subprocess
    import time
    con = console()
    query = ("temperature.gpu,utilization.gpu,memory.used,memory.total,"
             "power.draw,clocks.sm,clocks_throttle_reasons.active")

    def sample():
        proc = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            return None
        return [c.strip() for c in proc.stdout.strip().split(",")]

    if sample() is None:
        con.error("nvidia-smi returned no data")
        return 1

    def row_of(values):
        used, total = float(values[2]), float(values[3])
        return [[values[0] + " C", values[1] + " %",
                 f"{used:.0f} / {total:.0f} MiB",
                 f"{total - used:.0f} MiB", values[4] + " W",
                 values[5] + " MHz", values[6]]]

    columns = ["temp", "util", "vram", "free", "power", "sm clock", "throttle"]
    if not con.rich:
        try:
            while True:
                values = sample()
                if values:
                    con.out(render_markdown_table(columns, row_of(values)))
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    from rich.live import Live
    from rich.table import Table as RTable

    def render(values):
        table = RTable(header_style="bold cyan", show_edge=False)
        for name in columns:
            table.add_column(name, justify="right")
        used, total = float(values[2]), float(values[3])
        free = total - used
        table.add_row(values[0] + " C", values[1] + " %",
                      f"{used:.0f} / {total:.0f} MiB",
                      f"[{'red' if free < 300 else 'green'}]{free:.0f} MiB[/]",
                      values[4] + " W", values[5] + " MHz", values[6])
        return table

    try:
        with Live(render(sample()), console=console()._c, refresh_per_second=2) as live:
            while True:
                time.sleep(1)
                values = sample()
                if values:
                    live.update(render(values))
    except KeyboardInterrupt:
        pass
    return 0


def main(argv=None) -> int:
    import sys as _sys
    argv = list(_sys.argv[1:] if argv is None else argv)
    commands = {"profiles": cmd_profiles, "check": cmd_check, "vram": cmd_vram}
    if not argv or argv[0] not in commands:
        print(f"usage: llama_console.py {{{'|'.join(commands)}}}", file=_sys.stderr)
        return 2
    return commands[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
