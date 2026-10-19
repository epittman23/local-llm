"""benchmarks/grading - answer extraction, program execution, and calibration.

Ported from local-llm's scripts/llama_tests.py (outer repo). Each benchmark's
harness (humaneval.py, mbpp.py, ds1000.py) builds a standalone program from the
benchmark's OWN test material and this package runs it. The rule throughout:
the dataset decides correctness, this package only arranges for its verdict to
be reached.

GRADING RUNS MODEL-GENERATED PYTHON. It runs in a subprocess, in a temporary
working directory, under a timeout. That is process isolation, not a sandbox
-- it is what the upstream benchmark runners do, and it is safe enough for a
single-admin local deployment and not safe against adversarial output. This is
an unchanged trust model from the original CLI tool; no new sandboxing was
added in this port.

REGISTRY dispatches by harness name (adapter['check']['harness']), which for
every adapter shipped today is also the benchmark id -- but the dispatch key
is the harness, since that is what determines how a program is built and
graded.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from local_llm.benchmarks.evaluation.datasets import datasets_base_dir, read_manifest
from local_llm.env import SERVER_DIR

from . import ds1000, humaneval, mbpp

# ---------------------------------------------------------------------------
# outcomes
#
# `skipped` is deliberately not a failure. A DS-1000 item whose library is not
# installed says nothing about the model or the serving configuration, and
# counting it as a miss would make installing requirements-extra.txt look like
# a quality improvement.
# ---------------------------------------------------------------------------
PASS = 'pass'
FAIL_ASSERT = 'fail_assert'
FAIL_ERROR = 'fail_error'
FAIL_TIMEOUT = 'fail_timeout'
NO_CODE = 'no_code'
SKIPPED = 'skipped'

FAILURES = {FAIL_ASSERT, FAIL_ERROR, FAIL_TIMEOUT, NO_CODE}
GRADED = FAILURES | {PASS}  # everything except skipped


# ---------------------------------------------------------------------------
# per-benchmark dispatch
# ---------------------------------------------------------------------------
REGISTRY = {
    ds1000.NAME: ds1000,
    humaneval.NAME: humaneval,
    mbpp.NAME: mbpp,
}


def _harness(adapter: dict):
    name = adapter['check']['harness']
    module = REGISTRY.get(name)
    if module is None:
        raise ValueError(f"unknown harness '{name}'")
    return module


# ---------------------------------------------------------------------------
# answer extraction
# ---------------------------------------------------------------------------
FENCE = re.compile(r'```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n(.*?)```', re.DOTALL)


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
        with_def = [b for b in blocks if re.search(r'^\s*(async\s+)?def\s', b, re.M)]
        if with_def:
            return with_def[-1].strip('\n')
    return blocks[-1].strip('\n')


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------
def grader_python() -> str:
    """The interpreter graded code runs under.

    DS-1000 needs pandas/numpy from site-packages, so this must be the venv
    interpreter when there is one. LLAMA_GRADER_PYTHON overrides for the case
    where the venv running this package is not the one holding pandas.
    """
    override = os.environ.get('LLAMA_GRADER_PYTHON')
    if override:
        return override
    venv = SERVER_DIR / '.venv' / 'bin' / 'python'
    return str(venv) if venv.exists() else sys.executable


def libraries_available(names: list[str]) -> set[str]:
    """Which of these import in the grading interpreter.

    Probed in a subprocess against the interpreter that will actually run the
    graded code, which is not necessarily this one.
    """
    probe = (
        'import importlib.util,json,sys;'
        'print(json.dumps([n for n in sys.argv[1:] '
        'if importlib.util.find_spec(n.lower()) is not None]))'
    )
    try:
        out = subprocess.run([grader_python(), '-c', probe, *names], capture_output=True, text=True, timeout=60)
        return set(json.loads(out.stdout or '[]'))
    except (OSError, ValueError, subprocess.SubprocessError):
        return set()


def build_program(adapter: dict, item: dict, code: str) -> str | None:
    """The full program to execute, or None when the answer has no usable code."""
    return _harness(adapter).build_program(item, code)


def grader_env(workdir: str) -> dict[str, str]:
    """The whole environment graded code runs with: enough to start Python, nothing else.

    Not the backend's own environment, which holds DATABASE_URL, the session
    secret and the provider API keys -- model-written code has no business
    reading any of them. HOME and TMPDIR point at the per-run temporary
    directory, so libraries that write caches (matplotlib, numba) write there
    and the directory's removal takes them along.
    """
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        'HOME': workdir,
        'TMPDIR': workdir,
    }


# Bumped whenever a change to how programs are run can change a verdict, so
# a calibration made under an older harness reads as stale (calibration_stale).
HARNESS_VERSION = 2

# The program that runs a grading program. It is the subprocess's main script;
# the graded program is executed by it, never run directly, for three reasons:
#
#   - The verdict is a per-run nonce it prints only after the program, the
#     model's code and the dataset's tests together, ran to the end. Exit
#     status alone said PASS for code that called sys.exit(0) or
#     unittest.main() before any test ran (#126).
#   - The program runs as module `__graded__`, not `__main__`, so a model's
#     `if __name__ == '__main__':` block (often an input() loop) does not run,
#     as it would not when the dataset's own runner imports a solution.
#   - The nonce arrives on stdin, which is then replaced with /dev/null before
#     any graded code runs: it is in no file, argument or environment variable
#     the program could read, and lives only in main()'s frame.
#
# SystemExit is caught to say why the run ended early; every other exception
# propagates, so the traceback's last line still tells an assertion from an
# error.
DRIVER = """\
import os, sys, types


def main():
    nonce = sys.stdin.readline().strip()
    fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd, 0)
    os.close(fd)
    sys.stdin = sys.__stdin__ = open(os.devnull)

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'graded.py')
    module = types.ModuleType('__graded__')
    module.__file__ = path
    sys.modules['__graded__'] = module
    with open(path) as f:
        code = compile(f.read(), path, 'exec', dont_inherit=True)
    try:
        exec(code, module.__dict__)
    except SystemExit as exc:
        sys.stderr.write('SystemExit: the program exited (%r) before its tests finished\\n' % (exc.code,))
        sys.stderr.flush()
        os._exit(1)
    for stream in (sys.__stdout__, sys.__stderr__):
        try:
            stream.flush()
        except Exception:
            pass
    os.write(1, ('\\n' + nonce + '\\n').encode())


main()
"""


def _kill_group(proc: subprocess.Popen) -> None:
    """Kill everything the run started: the program and anything it forked."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _verdict(nonce: str, stdout: str | bytes | None) -> bool:
    if isinstance(stdout, bytes):
        stdout = stdout.decode(errors='replace')
    return nonce in (stdout or '').splitlines()


def run_program(source: str, timeout: int, isolated: bool) -> tuple[str, str]:
    """Execute a grading program. Returns (outcome, reason).

    PASS means the program ran to its end: the driver printed this run's
    nonce. The run is its own session, so on every exit, a timeout included,
    the whole process group is killed and nothing the program started
    outlives it (#142). A program whose tests finished but left a child
    holding stdout open still passes, on the nonce, when the timeout ends the
    wait. Graded code sees /dev/null on stdin and grader_env()'s environment.
    """
    nonce = secrets.token_hex(16)
    with tempfile.TemporaryDirectory(prefix='llama-grade.') as tmp:
        Path(tmp, 'graded.py').write_text(source)
        driver = Path(tmp, 'grade.py')
        driver.write_text(DRIVER)
        argv = [grader_python(), '-I']
        if isolated:
            # -S keeps site-packages out, so a HumanEval solution cannot pass by
            # importing something the benchmark never assumed was there.
            argv.append('-S')
        argv.append(str(driver))
        try:
            proc = subprocess.Popen(
                argv,
                cwd=tmp,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=grader_env(tmp),
                text=True,
                start_new_session=True,
            )
        except OSError as exc:
            return FAIL_ERROR, f'could not run grader: {exc}'
        try:
            stdout, stderr = proc.communicate(nonce + '\n', timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            _kill_group(proc)
            # What it printed before the deadline: finished tests count even
            # when something they left behind kept the pipe open.
            finished = _verdict(nonce, exc.stdout)
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            return (PASS, '') if finished else (FAIL_TIMEOUT, f'no result within {timeout}s')
        finally:
            _kill_group(proc)

    if _verdict(nonce, stdout):
        return PASS, ''

    err = (stderr or '').strip()
    tail = err.splitlines()[-1] if err else f'exit {proc.returncode} before its tests finished'
    if 'AssertionError' in err:
        return FAIL_ASSERT, tail
    return FAIL_ERROR, tail


def grade(adapter: dict, item: dict, answer: str) -> tuple[str, str]:
    """Grade one answer against the benchmark's own tests."""
    module = _harness(adapter)
    code = extract_code(answer or '', want_def=module.WANT_DEF)
    program = module.build_program(item, code)
    if program is None:
        return NO_CODE, 'no code in the response'
    check = adapter['check']
    return run_program(program, int(check.get('timeout', 30)), bool(check.get('isolated', True)))


# ---------------------------------------------------------------------------
# grader self-check
# ---------------------------------------------------------------------------
def reference_answer(adapter: dict, item: dict) -> str | None:
    """The benchmark's own solution, dressed as if a model had answered it.

    This is how the graders are tested without a model. A correct harness
    scores these at ~100%; anything less is a bug in this package, not in an
    answer. It is deliberately wrapped in a fence and pushed back through
    extract_code and build_program, so the extraction path is exercised too --
    a grader that only works on already-clean code would pass a check that
    skipped those steps.

    Returns None when the dataset does not ship a reference for this item.
    """
    return _harness(adapter).reference_answer(item)


def env_fingerprint() -> dict:
    """The grading environment, as the interpreter that will grade sees it.

    Recorded with every calibration because it is what a calibration is about:
    the same item is gradeable under one set of library versions and not under
    another. Probed in the grading subprocess, not in this one, since this
    package may run under a different interpreter than LLAMA_GRADER_PYTHON
    names.
    """
    probe = (
        'import json,sys\n'
        'import importlib.metadata as md\n'
        "out={'python': '%d.%d.%d' % sys.version_info[:3]}\n"
        "for name in ('numpy','pandas','scipy','scikit-learn','pyyaml'):\n"
        '    try: out[name]=md.version(name)\n'
        '    except Exception: pass\n'
        'print(json.dumps(out, sort_keys=True))\n'
    )
    try:
        proc = subprocess.run([grader_python(), '-c', probe], capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout or '{}')
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def calibration_path(bench: str, base: Path | None = None) -> Path:
    return (base or datasets_base_dir()) / bench / 'CALIBRATION.json'


def read_calibration(bench: str, base: Path | None = None) -> dict | None:
    path = calibration_path(bench, base)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def calibration_stale(bench: str, base: Path | None = None) -> str:
    """Why a stored calibration no longer applies, or "" when it still does."""
    cal = read_calibration(bench, base)
    if cal is None:
        return 'not calibrated yet'
    manifest = read_manifest(bench, base) or {}
    if cal.get('content_sha256') != manifest.get('content_sha256'):
        return 'the dataset was refetched since it was calibrated'
    if cal.get('harness_version') != HARNESS_VERSION:
        return 'the grader changed how it runs programs since it was calibrated'
    if cal.get('environment') != env_fingerprint():
        return 'the grading environment changed since it was calibrated'
    return ''


def ungradeable(bench: str, base: Path | None = None) -> dict[str, str]:
    """Item ids whose own reference solution does not pass here, and why.

    This is the load-bearing idea behind calibration. DS-1000 was published in
    2022 against pandas 1.x; on pandas 3 a chunk of it fails before any model
    is involved, because DataFrame.append and replace(method=) no longer
    exist. Grading a model against a test its own dataset cannot pass measures
    the library version, not the model -- so those items are skipped, with the
    benchmark's own verdict as the evidence, rather than scored as failures.

    An empty result when nothing is calibrated: the check has to be run
    deliberately, and a missing calibration is reported by the caller rather
    than silently assumed to be all-clear.
    """
    cal = read_calibration(bench, base)
    if not cal or calibration_stale(bench, base):
        return {}
    return dict(cal.get('ungradeable', {}))


def calibration_workers() -> int:
    """How many reference solutions selfcheck grades at once: half the CPUs, at most eight.

    Each is its own subprocess, and DS-1000's take a second or more to import
    pandas, so one at a time made a selfcheck take a quarter of an hour.
    """
    return max(1, min(8, (os.cpu_count() or 2) // 2))


def calibrate(
    bench: str, adapter: dict, items: list[dict], on_item=None, base: Path | None = None, workers: int | None = None
) -> dict:
    """Grade every reference solution and record which ones this box can verify.

    Returns the calibration record; the caller writes it. Every item is pushed
    through the same extract_code/build_program/run_program path a model
    answer takes, so this tests the harness end to end and not just the exec
    call. Items are graded `workers` at a time and reported to on_item in
    their own order; an exception from on_item stops the calibration (the
    Tests page's cancel) and propagates, with nothing returned to write.
    """
    from concurrent.futures import ThreadPoolExecutor

    from local_llm.benchmarks.evaluation.datasets import item_id

    def check(item: dict) -> tuple[str, str, str]:
        ref = reference_answer(adapter, item)
        if ref is None:
            return item_id(adapter, item), 'no_reference', 'the dataset ships no reference solution'
        return (item_id(adapter, item), *grade(adapter, item, ref))

    ungradeable_: dict[str, str] = {}
    # Every item is counted: `n_checked` is the pool this calibration covers
    # and `n_checked - n_ungradeable` is read as the gradeable count, so an
    # item in `ungradeable_` but not in `checked` makes that go negative.
    checked = 0
    pool = ThreadPoolExecutor(max_workers=workers or calibration_workers())
    try:
        for iid, outcome, reason in pool.map(check, items):
            checked += 1
            if outcome == 'no_reference':
                ungradeable_[iid] = reason
            elif outcome != PASS:
                ungradeable_[iid] = f'{outcome}: {reason}'[:200]
            if on_item:
                on_item(iid, outcome, reason)
    finally:
        pool.shutdown(wait=True, cancel_futures=True)

    manifest = read_manifest(bench, base) or {}
    return {
        'benchmark': bench,
        'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'content_sha256': manifest.get('content_sha256', ''),
        'revision': manifest.get('revision', ''),
        'environment': env_fingerprint(),
        'harness_version': HARNESS_VERSION,
        'grader_python': grader_python(),
        'n_checked': checked,
        'n_ungradeable': len(ungradeable_),
        'ungradeable': dict(sorted(ungradeable_.items())),
    }


def write_calibration(bench: str, record: dict, base: Path | None = None) -> Path:
    path = calibration_path(bench, base)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=False) + '\n')
    return path
