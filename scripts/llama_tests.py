#!/usr/bin/env python3
"""llama_tests.py - benchmark adapters, item selection, and grading.

Part of https://github.com/epittman23/local-llm

Every test item in this project comes from a published benchmark that ships its
own ground truth. Nothing here states an answer:

  HumanEval   each item carries `test` (a check(candidate) function) and `entry_point`
  MBPP        each item carries `test_imports` and `test_list` (three asserts)
  DS-1000     each item carries `code_context`, which defines test_execution(solution)

The files in tests/adapters/ describe only *adaptation* -- how a completion-style
stub becomes a chat turn, which harness grades it, how long it may run. The
datasets themselves are fetched into tests/data/ (gitignored) by llama_fetch.py,
which pins the upstream revision that every result is then recorded against.

GRADING RUNS MODEL-GENERATED PYTHON. It runs in a subprocess, in a temporary
working directory, under a timeout. That is process isolation, not a sandbox --
it is what the upstream benchmark runners do, and it is safe enough for a
single-user local box and not safe against adversarial output.

Stdlib only, on purpose: llama_stats.py and the telemetry recorder are invoked with
bare `python3` and cannot depend on the venv, and this module is imported from
the same places.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ADAPTERS = REPO / "tests" / "adapters"
SUITES = REPO / "tests" / "suites"


def data_dir() -> Path:
    """Where fetched datasets live. Overridable so a run can point at a copy."""
    return Path(os.environ.get("LLAMA_TESTS_DATA", REPO / "tests" / "data"))


# ---------------------------------------------------------------------------
# outcomes
#
# `skipped` is deliberately not a failure. A DS-1000 item whose library is not
# installed says nothing about the model or the serving configuration, and
# counting it as a miss would make installing requirements-extra.txt look like a
# quality improvement.
# ---------------------------------------------------------------------------
PASS = "pass"
FAIL_ASSERT = "fail_assert"
FAIL_ERROR = "fail_error"
FAIL_TIMEOUT = "fail_timeout"
NO_CODE = "no_code"
SKIPPED = "skipped"

FAILURES = {FAIL_ASSERT, FAIL_ERROR, FAIL_TIMEOUT, NO_CODE}
GRADED = FAILURES | {PASS}          # everything except skipped


# ---------------------------------------------------------------------------
# adapters and suites
# ---------------------------------------------------------------------------
def load_adapters() -> dict[str, dict]:
    out = {}
    for path in sorted(ADAPTERS.glob("*.toml")):
        with open(path, "rb") as fh:
            adapter = tomllib.load(fh)
        adapter["_path"] = str(path)
        adapter["_sha"] = adapter_sha(adapter)
        out[adapter["id"]] = adapter
    return out


# The fields that change what a model is asked or how its answer is graded. A
# benchmark's identity was `dataset_revision` alone, which covers the published
# items and nothing this repo wraps around them -- so editing prompt_template
# silently made old and new results incomparable with nothing recording the
# discontinuity, which is the problem config_id and system_sha already solve
# for serving flags and system prompts. Recorded per result as adapter_sha.
FINGERPRINTED = ("prompt_template", "item", "filter", "check")


def adapter_sha(adapter: dict) -> str:
    """Fingerprint an adapter over the fields that affect a measurement.

    Over the parsed subset rather than the file's bytes, which is the one place
    this deliberately differs from system_sha: an adapter carries the prose
    explaining why it is shaped the way it is, and hashing the bytes would file
    every comment edit as a measurement discontinuity. `id`, `name`, `license`,
    `homepage`, `citation` and `[fetch]` are excluded for the same reason --
    they say where the benchmark came from, not what was asked of the model.
    """
    payload = {k: adapter[k] for k in FINGERPRINTED if k in adapter}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


def load_suite(name: str) -> dict:
    path = SUITES / f"{name}.toml"
    if not path.exists():
        known = ", ".join(sorted(p.stem for p in SUITES.glob("*.toml")))
        raise SystemExit(f"llama-test: no suite '{name}' (known: {known})")
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def dotted(obj: dict, path: str):
    """Read "metadata.problem_id" out of a nested record."""
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


# ---------------------------------------------------------------------------
# fetched datasets
# ---------------------------------------------------------------------------
def items_path(bench: str) -> Path:
    return data_dir() / bench / "items.jsonl"


def manifest_path(bench: str) -> Path:
    return data_dir() / bench / "MANIFEST.json"


def read_manifest(bench: str) -> dict | None:
    path = manifest_path(bench)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def read_items(bench: str) -> list[dict]:
    path = items_path(bench)
    if not path.exists():
        raise SystemExit(
            f"llama-test: {bench} is not downloaded yet.\n"
            f"  run: llama-test fetch {bench}")
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def item_id(adapter: dict, item: dict) -> str:
    """The dataset's own identifier for an item, never a positional index.

    Positional ids would silently change meaning when the upstream dataset gains
    or loses a row, and a result file outlives the dataset revision that made it.
    """
    raw = dotted(item, adapter["item"]["id_field"])
    return str(raw)


# ---------------------------------------------------------------------------
# filtering and sampling
# ---------------------------------------------------------------------------
def libraries_available(names: list[str]) -> set[str]:
    """Which of these import in the grading interpreter.

    Probed in a subprocess against the interpreter that will actually run the
    graded code, which is not necessarily this one: llama-test may run under the
    venv while a caller passes a different grader.
    """
    probe = ("import importlib.util,json,sys;"
             "print(json.dumps([n for n in sys.argv[1:] "
             "if importlib.util.find_spec(n.lower()) is not None]))")
    try:
        out = subprocess.run([grader_python(), "-c", probe, *names],
                             capture_output=True, text=True, timeout=60)
        return set(json.loads(out.stdout or "[]"))
    except (OSError, ValueError, subprocess.SubprocessError):
        return set()


def filter_items(adapter: dict, items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split into (runnable, skipped) by the adapter's library filter."""
    spec = adapter.get("filter")
    if not spec:
        return items, []
    field, wanted = spec["field"], set(spec["values"])
    keep, drop = [], []
    for it in items:
        (keep if dotted(it, field) in wanted else drop).append(it)
    return keep, drop


def sample(items: list[dict], n: int, seed: int, adapter: dict) -> list[dict]:
    """A seeded sample, stable across runs and across configurations.

    Sorted by the dataset's own id before sampling, so the selection does not
    depend on the order the rows happened to be written in. n <= 0 means every
    item -- that is what the `full` tier asks for.
    """
    ordered = sorted(items, key=lambda it: item_id(adapter, it))
    if n <= 0 or n >= len(ordered):
        return ordered
    return sorted(random.Random(seed).sample(ordered, n),
                  key=lambda it: item_id(adapter, it))


# ---------------------------------------------------------------------------
# prompts
# ---------------------------------------------------------------------------
def render_prompt(adapter: dict, item: dict) -> str:
    """Fill the adapter's template from the item's own fields.

    str.format is not used: benchmark prompts are full of braces (dict literals,
    f-strings, LaTeX) and would blow up or be silently mangled by it. Only the
    named placeholders the adapters actually declare are substituted.
    """
    text = adapter["prompt_template"]
    body = dotted(item, adapter["item"]["prompt_field"]) or ""
    fields = {"prompt": body}
    if adapter["id"] == "mbpp":
        fields["tests"] = "\n".join(item.get("test_list", []))
    for key, value in fields.items():
        text = text.replace("{" + key + "}", value)
    return text


# ---------------------------------------------------------------------------
# answer extraction
# ---------------------------------------------------------------------------
FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n(.*?)```", re.DOTALL)


def extract_code(answer: str, want_def: bool = False) -> str:
    """The code the model meant as its answer.

    The last fenced block wins, because a thinking model that reconsiders puts
    the final version last. When a definition is required, the last block that
    actually contains one wins instead -- models routinely follow a complete
    solution with a short usage snippet, and taking that snippet would fail an
    answer that was correct.

    An unfenced answer is used whole. That is usually a model that ignored the
    formatting instruction rather than one that produced no code, and letting
    the grader reject it is more honest than declaring no_code here.
    """
    blocks = [body for _, body in FENCE.findall(answer)]
    if not blocks:
        return answer.strip()
    if want_def:
        with_def = [b for b in blocks if re.search(r"^\s*(async\s+)?def\s", b, re.M)]
        if with_def:
            return with_def[-1].strip("\n")
    return blocks[-1].strip("\n")


# ---------------------------------------------------------------------------
# graders
#
# Each builds a standalone program from the benchmark's OWN test material and
# runs it. The rule throughout: the dataset decides correctness, this file only
# arranges for its verdict to be reached.
# ---------------------------------------------------------------------------
def grader_python() -> str:
    """The interpreter graded code runs under.

    DS-1000 needs pandas/numpy from site-packages, so this must be the venv
    interpreter when there is one. LLAMA_GRADER_PYTHON overrides for the case
    where the venv running llama-test is not the one holding pandas.
    """
    override = os.environ.get("LLAMA_GRADER_PYTHON")
    if override:
        return override
    venv = REPO / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def build_program(adapter: dict, item: dict, code: str) -> str | None:
    """The full program to execute, or None when the answer has no usable code."""
    harness = adapter["check"]["harness"]

    if harness == "humaneval":
        if not code.strip():
            return None
        entry = item["entry_point"]
        # A model asked for the complete function normally returns it. When it
        # returned only a body -- the completion-style answer the stub invites --
        # the stub is prepended so that answer is graded rather than discarded.
        if not re.search(rf"^\s*(async\s+)?def\s+{re.escape(entry)}\b", code, re.M):
            code = item["prompt"] + "\n" + code
        return "\n\n".join([code, item["test"], f"check({entry})", ""])

    if harness == "mbpp":
        if not code.strip():
            return None
        parts = list(item.get("test_imports") or [])
        parts.append(code)
        parts.extend(item.get("test_list") or [])
        return "\n\n".join(parts) + "\n"

    if harness == "ds1000":
        if not code.strip():
            return None
        # json.dumps emits a valid Python string literal, which keeps the
        # model's quotes, backslashes and newlines out of the program's syntax.
        solution = json.dumps(code)
        parts = [item["code_context"], "",
                 f"__solution = {solution}",
                 "test_execution(__solution)"]
        # Some items additionally constrain the surface form (a required API, a
        # banned keyword). The upstream runner calls it when present, so so do we.
        if re.search(r"^def\s+test_string\s*\(", item["code_context"], re.M):
            parts.append("test_string(__solution)")
        return "\n".join(parts) + "\n"

    raise ValueError(f"unknown harness '{harness}'")


def run_program(source: str, timeout: int, isolated: bool) -> tuple[str, str]:
    """Execute a grading program. Returns (outcome, reason)."""
    with tempfile.TemporaryDirectory(prefix="llama-grade.") as tmp:
        path = Path(tmp) / "grade.py"
        path.write_text(source)
        argv = [grader_python(), "-I"]
        if isolated:
            # -S keeps site-packages out, so a HumanEval solution cannot pass by
            # importing something the benchmark never assumed was there.
            argv.append("-S")
        argv.append(str(path))
        try:
            proc = subprocess.run(argv, cwd=tmp, capture_output=True,
                                  text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return FAIL_TIMEOUT, f"no result within {timeout}s"
        except OSError as exc:
            return FAIL_ERROR, f"could not run grader: {exc}"

    if proc.returncode == 0:
        return PASS, ""

    err = (proc.stderr or "").strip()
    tail = err.splitlines()[-1] if err else f"exit {proc.returncode}"
    if "AssertionError" in err:
        return FAIL_ASSERT, tail
    return FAIL_ERROR, tail


def grade(adapter: dict, item: dict, answer: str) -> tuple[str, str]:
    """Grade one answer against the benchmark's own tests."""
    want_def = adapter["check"]["harness"] in ("humaneval", "mbpp")
    code = extract_code(answer or "", want_def=want_def)
    program = build_program(adapter, item, code)
    if program is None:
        return NO_CODE, "no code in the response"
    check = adapter["check"]
    return run_program(program, int(check.get("timeout", 30)),
                       bool(check.get("isolated", True)))


# ---------------------------------------------------------------------------
# suite assembly
# ---------------------------------------------------------------------------
def build_suite(suite: dict, adapters: dict[str, dict],
                only: str | None = None) -> tuple[list[dict], list[dict]]:
    """Resolve a tier into the concrete list of items to run.

    Returns (selected, skipped). Skipped entries carry their reason so a run
    records what it could not attempt rather than quietly shrinking.
    """
    seed = int(suite.get("seed", 0))
    selected: list[dict] = []
    skipped: list[dict] = []

    for entry in suite.get("benchmark", []):
        bench = entry["id"]
        if only and bench != only:
            continue
        adapter = adapters.get(bench)
        if adapter is None:
            raise SystemExit(f"llama-test: suite '{suite['id']}' names unknown "
                             f"benchmark '{bench}'")
        items = read_items(bench)
        keep, dropped = filter_items(adapter, items)

        # "kind" separates the two reasons an item can be out of the pool,
        # because they are invalidated by different things: the library filter
        # by editing the adapter, the calibration by a dataset refetch or a
        # library upgrade on this box.
        for it in dropped:
            skipped.append({"benchmark": bench, "item_id": item_id(adapter, it),
                            "kind": "library_filter",
                            "reason": "outside the adapter's library filter"})

        # Applied before sampling, not after. Dropping items from an already
        # drawn sample would give each benchmark a different effective n and
        # make the tier's advertised size a fiction; dropping them from the
        # pool keeps every tier exactly the size it says it is.
        blocked = ungradeable(bench)
        if blocked:
            still = []
            for it in keep:
                iid = item_id(adapter, it)
                if iid in blocked:
                    skipped.append({"benchmark": bench, "item_id": iid,
                                    "kind": "ungradeable",
                                    "reason": f"ungradeable here ({blocked[iid]})"})
                else:
                    still.append(it)
            keep = still

        # The seed is offset per benchmark so the three do not draw parallel
        # index sequences, which would correlate the samples across benchmarks.
        chosen = sample(keep, int(entry.get("n", 0)),
                        seed + sum(map(ord, bench)), adapter)
        for it in chosen:
            selected.append({"benchmark": bench, "adapter": adapter, "item": it,
                             "item_id": item_id(adapter, it)})

    return selected, skipped


def missing_libraries(selected: list[dict]) -> dict[str, str]:
    """Item ids that cannot be graded here, mapped to why.

    Checked once up front rather than per item: importing pandas costs about a
    second, and a `full` DS-1000 run would otherwise pay it 510 times to learn
    the same fact.
    """
    needs = {"ds1000": {"Pandas": "pandas", "Numpy": "numpy",
                        "Scipy": "scipy", "Sklearn": "sklearn",
                        "Matplotlib": "matplotlib", "Tensorflow": "tensorflow",
                        "Pytorch": "torch"}}
    wanted: set[str] = set()
    for row in selected:
        table = needs.get(row["benchmark"])
        if table:
            lib = dotted(row["item"], "metadata.library")
            if lib in table:
                wanted.add(table[lib])
    if not wanted:
        return {}
    have = {n.lower() for n in libraries_available(sorted(wanted))}

    out: dict[str, str] = {}
    for row in selected:
        table = needs.get(row["benchmark"])
        if not table:
            continue
        module = table.get(dotted(row["item"], "metadata.library"))
        if module and module.lower() not in have:
            out[f"{row['benchmark']}/{row['item_id']}"] = (
                f"{module} is not installed in the grading environment")
    return out


# ---------------------------------------------------------------------------
# grader self-check
# ---------------------------------------------------------------------------
def reference_answer(adapter: dict, item: dict) -> str | None:
    """The benchmark's own solution, dressed as if a model had answered it.

    This is how the graders are tested without a model. A correct harness scores
    these at ~100%; anything less is a bug in this file, not in an answer. It is
    deliberately wrapped in a fence and pushed back through extract_code and
    build_program, so the extraction path is exercised too -- a grader that only
    works on already-clean code would pass a check that skipped those steps.

    Returns None when the dataset does not ship a reference for this item.
    """
    harness = adapter["check"]["harness"]
    if harness == "humaneval":
        body = item.get("canonical_solution")
        code = item["prompt"] + body if body else None
    elif harness == "mbpp":
        code = item.get("code")
    elif harness == "ds1000":
        code = item.get("reference_code")
    else:
        raise ValueError(f"unknown harness '{harness}'")
    return f"```python\n{code}\n```\n" if code else None


def env_fingerprint() -> dict:
    """The grading environment, as the interpreter that will grade sees it.

    Recorded with every calibration because it is what a calibration is about:
    the same item is gradeable under one set of library versions and not under
    another. Probed in the grading subprocess, not in this one, since llama-test
    may run under a different interpreter than LLAMA_GRADER_PYTHON names.
    """
    probe = (
        "import json,sys\n"
        "import importlib.metadata as md\n"
        "out={'python': '%d.%d.%d' % sys.version_info[:3]}\n"
        "for name in ('numpy','pandas','scipy','scikit-learn','pyyaml'):\n"
        "    try: out[name]=md.version(name)\n"
        "    except Exception: pass\n"
        "print(json.dumps(out, sort_keys=True))\n")
    try:
        proc = subprocess.run([grader_python(), "-c", probe],
                              capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def calibration_path(bench: str) -> Path:
    return data_dir() / bench / "CALIBRATION.json"


def read_calibration(bench: str) -> dict | None:
    path = calibration_path(bench)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def calibration_stale(bench: str) -> str:
    """Why a stored calibration no longer applies, or "" when it still does."""
    cal = read_calibration(bench)
    if cal is None:
        return "not calibrated yet"
    manifest = read_manifest(bench) or {}
    if cal.get("content_sha256") != manifest.get("content_sha256"):
        return "the dataset was refetched since it was calibrated"
    if cal.get("environment") != env_fingerprint():
        return "the grading environment changed since it was calibrated"
    return ""


def ungradeable(bench: str) -> dict[str, str]:
    """Item ids whose own reference solution does not pass here, and why.

    This is the load-bearing idea behind calibration. DS-1000 was published in
    2022 against pandas 1.x; on pandas 3 a chunk of it fails before any model is
    involved, because DataFrame.append and replace(method=) no longer exist.
    Grading a model against a test its own dataset cannot pass measures the
    library version, not the model -- so those items are skipped, with the
    benchmark's own verdict as the evidence, rather than scored as failures.

    An empty result when nothing is calibrated: the check has to be run
    deliberately (`llama-test selfcheck`), and a missing calibration is reported
    by the caller rather than silently assumed to be all-clear.
    """
    cal = read_calibration(bench)
    if not cal or calibration_stale(bench):
        return {}
    return dict(cal.get("ungradeable", {}))


def calibrate(bench: str, adapter: dict, items: list[dict],
              on_item=None) -> dict:
    """Grade every reference solution and record which ones this box can verify.

    Returns the calibration record; the caller writes it. Every item is pushed
    through the same extract_code/build_program/run_program path a model answer
    takes, so this tests the harness end to end and not just the exec call.
    """
    ungradeable_: dict[str, str] = {}
    checked = 0
    for item in items:
        ref = reference_answer(adapter, item)
        iid = item_id(adapter, item)
        # Counted before the early return, not after: `n_checked` is the pool
        # this calibration covers and `n_checked - n_ungradeable` is read as the
        # gradeable count, so an item that lands in `ungradeable_` without
        # landing in `checked` makes that subtraction go negative.
        checked += 1
        if ref is None:
            ungradeable_[iid] = "the dataset ships no reference solution"
            continue
        outcome, reason = grade(adapter, item, ref)
        if outcome != PASS:
            ungradeable_[iid] = f"{outcome}: {reason}"[:200]
        if on_item:
            on_item(iid, outcome, reason)

    manifest = read_manifest(bench) or {}
    return {
        "benchmark": bench,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "content_sha256": manifest.get("content_sha256", ""),
        "revision": manifest.get("revision", ""),
        "environment": env_fingerprint(),
        "grader_python": grader_python(),
        "n_checked": checked,
        "n_ungradeable": len(ungradeable_),
        "ungradeable": dict(sorted(ungradeable_.items())),
    }


def write_calibration(bench: str, record: dict) -> Path:
    path = calibration_path(bench)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=False) + "\n")
    return path
