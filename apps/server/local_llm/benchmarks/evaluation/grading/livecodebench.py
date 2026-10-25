"""benchmarks/evaluation/grading/livecodebench.py - the LiveCodeBench harness.

Two kinds of problem, told apart as LiveCodeBench tells them apart, by
whether the problem's metadata names a `func_name`:

- **Functional (LeetCode).** One grading program, run like every other
  harness's under the driver in grading/__init__.py: livecodebench_runtime.py
  calls the answer's method on each test and compares the result. The tests
  go beside the program as a file.
- **Stdin (AtCoder, Codeforces).** The answer is a script. It runs once per
  test, as `__main__`, in its own subprocess with the test's input piped to
  stdin and LiveCodeBench's import header loaded first, and its stdout is
  compared here, in the grader, with LiveCodeBench's rule. The verdict
  never comes from the program's own exit status, so the early exits #126
  was about cannot pass.

  LiveCodeBench at commit 28fef95e grades these in one process instead: it
  wraps the script in a function, mocks stdin and captures stdout. Real
  stdin through a pipe is used here because that mock has two faults that
  fail correct answers. Its `sys.stdin.buffer.readline` returns the first
  line on every call, which breaks the usual fast-input idiom, and moving
  every top-level statement into a function breaks a helper's `global x`.

Limits, as LiveCodeBench sets them: 6 s per test, and (6 + 1) x tests + 5 s
for the whole problem. Tests run public first, then private, and the first
failure ends the problem.

There are no reference solutions, so this harness cannot be calibrated
(CALIBRATABLE). This module only arranges for the dataset's own tests to be
applied; it never states an answer.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

NAME = 'livecodebench'
WANT_DEF = False
CALIBRATABLE = False

RUNTIME = Path(__file__).with_name('livecodebench_runtime.py').read_text()

# The interpreter starts before a stdin test's clock should: LiveCodeBench's
# 6 s alarm times the answer, not Python's start-up and the import header.
STARTUP_SECONDS = 1.0

# The script a stdin test runs: LiveCodeBench's import header into the
# globals, then the answer as __main__. A SystemExit is swallowed, as
# LiveCodeBench's call_method() swallows it, so output followed by exit(1)
# is graded on the output. Any other exception is a non-zero exit.
STDIN_DRIVER = """\
import os, runpy, sys
# LiveCodeBench's reliability_guard sets this, before numpy can start its pools.
os.environ['OMP_NUM_THREADS'] = '1'
try:
    import resource
    _, _hard = resource.getrlimit(resource.RLIMIT_AS)
    _limit = {limit} if _hard == resource.RLIM_INFINITY else min({limit}, _hard)
    resource.setrlimit(resource.RLIMIT_AS, (_limit, _hard))
except (ImportError, ValueError, OSError):
    pass
sys.set_int_max_str_digits({digits})
_g = {{}}
exec({header!r}, _g)
_g.pop('__builtins__', None)
_path = sys.argv[1]
sys.argv = [_path]
try:
    runpy.run_path(_path, init_globals=_g, run_name='__main__')
except SystemExit:
    pass
"""


def extract_code(answer: str) -> str:
    """lcb_runner/utils/extraction_utils.py's extract_code(): the lines between the last two fence lines.

    A reply with fewer than two lines containing ``` has no code.
    """
    lines = answer.split('\n')
    fences = [i for i, line in enumerate(lines) if '```' in line]
    if len(fences) < 2:
        return ''
    return '\n'.join(lines[fences[-2] + 1 : fences[-1]])


def is_functional(item: dict) -> bool:
    return bool((item.get('metadata') or {}).get('func_name'))


def problem_timeout(check: dict, n_tests: int) -> float:
    """LiveCodeBench's global timeout for a problem: (timeout + 1) x tests + 5."""
    return (float(check['timeout_per_test']) + 1) * n_tests + 5


def all_tests(adapter: dict, item: dict) -> list[dict]:
    from local_llm.benchmarks.evaluation import livecodebench_data

    return list(item['public_test_cases']) + livecodebench_data.private_tests(adapter, item)


# ---------------------------------------------------------------------------
# stdin output comparison (testing_util.py, grade_stdio)
# ---------------------------------------------------------------------------
def stripped_lines(text: str) -> list[str]:
    return [line.strip() for line in text.strip().split('\n')]


def _decimals(line: str) -> list[Decimal] | None:
    try:
        return [Decimal(token) for token in line.split()]
    except (InvalidOperation, ValueError):
        return None


def compare_stdout(got: str, expected: str) -> str:
    """'' when the output matches, else why not: exact lines, or every token equal as a Decimal."""
    got_lines, want_lines = stripped_lines(got), stripped_lines(expected)
    if len(got_lines) != len(want_lines):
        return f'{len(got_lines)} output lines, expected {len(want_lines)}'
    for i, (g, w) in enumerate(zip(got_lines, want_lines, strict=True)):
        if g == w:
            continue
        gd, wd = _decimals(g), _decimals(w)
        if gd is not None and wd is not None and gd == wd:
            continue
        return f'line {i}: got {_clip(g)!r}, expected {_clip(w)!r}'
    return ''


def _clip(text: str) -> str:
    return text if len(text) <= 80 else text[:77] + '...'


# ---------------------------------------------------------------------------
# grading
# ---------------------------------------------------------------------------
def build_program(item: dict, code: str, check: dict) -> str | None:
    """The functional problem's grading program, or None when the answer has no code."""
    if not code.strip():
        return None
    spec = {
        'code': code,
        'func_name': item['metadata']['func_name'],
        'timeout': float(check['timeout_per_test']),
        'memory_limit_bytes': int(check['memory_limit_gib'] * 2**30),
    }
    return RUNTIME + '\n\n' + f'main({json.dumps(spec)!r})\n'


def reference_answer(item: dict) -> str | None:
    """LiveCodeBench ships no reference solutions."""
    return None


def grade(adapter: dict, item: dict, answer: str) -> tuple[str, str]:
    from local_llm.benchmarks.evaluation import grading

    code = extract_code(answer)
    if not code.strip():
        return grading.NO_CODE, 'no fenced code block in the response'
    check = adapter['check']
    tests = all_tests(adapter, item)
    if is_functional(item):
        program = build_program(item, code, check)
        if program is None:
            return grading.NO_CODE, 'no code in the response'
        files = {'tests.json': json.dumps(tests).encode()}
        return grading.run_program(
            program, problem_timeout(check, len(tests)), bool(check.get('isolated', False)), files=files
        )
    return grade_stdin(code, tests, check)


def grade_stdin(code: str, tests: list[dict], check: dict) -> tuple[str, str]:
    """Run the script once per test with its input on stdin, and compare what it prints."""
    from local_llm.benchmarks.evaluation import grading
    from local_llm.benchmarks.evaluation.grading import livecodebench_runtime as rt

    per_test = float(check['timeout_per_test'])
    deadline = time.monotonic() + problem_timeout(check, len(tests))
    driver = STDIN_DRIVER.format(
        limit=int(check['memory_limit_gib'] * 2**30), digits=rt.INT_MAX_STR_DIGITS, header=rt.IMPORT_STRING
    )
    with tempfile.TemporaryDirectory(prefix='llama-grade.') as tmp:
        answer = Path(tmp, 'answer.py')
        answer.write_text(code)
        runner = Path(tmp, 'run.py')
        runner.write_text(driver)
        argv = [grading.grader_python(), '-I']
        if check.get('isolated', False):
            argv.append('-S')
        argv += [str(runner), str(answer)]
        for i, test in enumerate(tests):
            left = deadline - time.monotonic()
            if left <= 0:
                return grading.FAIL_TIMEOUT, f'test {i}: the problem ran past its overall limit'
            limit = min(per_test + STARTUP_SECONDS, left)
            outcome, detail = _run_one(argv, tmp, test['input'], limit)
            if outcome == 'timeout':
                return grading.FAIL_TIMEOUT, f'test {i} ran past its {per_test:g} s limit'
            if outcome == 'error':
                return grading.FAIL_ERROR, f'test {i}: {detail}'
            why = compare_stdout(detail, test['output'])
            if why:
                return grading.FAIL_ASSERT, f'test {i}: wrong answer, {why}'
    return grading.PASS, ''


def _run_one(argv: list[str], cwd: str, stdin: str, timeout: float) -> tuple[str, str]:
    """('ok', stdout), ('error', why) or ('timeout', '') for one run of the script."""
    from local_llm.benchmarks.evaluation import grading

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=grading.grader_env(cwd),
            start_new_session=True,
        )
    except OSError as exc:
        return 'error', f'could not run the answer: {exc}'
    try:
        out, err = proc.communicate(stdin.encode(), timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        exited = proc.poll() is not None
        grading.kill_group(proc)
        # Bounded, as run_program's is (#142): a child the answer started in
        # a session of its own outlives kill_group and can hold the pipes.
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if not exited:
            return 'timeout', ''
        # The script itself finished; something it left behind kept the pipe
        # open. Its output so far is its answer.
        out, err = exc.stdout or b'', exc.stderr or b''
    finally:
        grading.kill_group(proc)
    if proc.returncode != 0:
        lines = err.decode(errors='replace').strip().splitlines()
        return 'error', lines[-1] if lines else f'exit {proc.returncode}'
    return 'ok', out.decode(errors='replace')
