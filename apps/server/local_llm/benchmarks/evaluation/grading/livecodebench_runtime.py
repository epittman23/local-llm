"""benchmarks/evaluation/grading/livecodebench_runtime.py - the code a LiveCodeBench functional grade runs.

Not imported by the grader: livecodebench.py embeds this file's source in the
grading program for a LeetCode (functional) problem, followed by one call to
main(), and runs it under the driver in grading/__init__.py. The tests arrive
as `tests.json` beside the program, since a problem's inputs can run to tens
of MB. It is also an ordinary module, so the tests import it directly.

Ported from LiveCodeBench at commit 28fef95e (MIT, see NOTICE),
lcb_runner/evaluation/testing_util.py, grade_call_based() and compile_code():

- IMPORT_STRING is prepended to the answer, as there. It imports the standard
  modules an answer may use without importing them (`gcd`, `deque`, ...) and
  raises the recursion limit to 50000.
- The answer is loaded as module `tmp_sol` within the per-test limit. If its
  text contains `class Solution`, the method is called on `Solution()`;
  otherwise the function of that name in the module is.
- Each test's input is one JSON value per line, one line per argument, and
  its output one JSON value. A tuple result is compared as a list, and the
  comparison is exact.
- Tests run public first, then private, and the first failure ends the
  problem.

The verdict is the driver's nonce, printed only after main() returns.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import types

# lcb_runner/evaluation/testing_util.py's import_string, verbatim.
IMPORT_STRING = (
    'from string import *\nfrom re import *\nfrom datetime import *\nfrom collections import *\n'
    'from heapq import *\nfrom bisect import *\nfrom copy import *\nfrom math import *\nfrom random import *\n'
    'from statistics import *\nfrom itertools import *\nfrom functools import *\nfrom operator import *\n'
    'from io import *\nfrom sys import *\nfrom json import *\nfrom builtins import *\nfrom typing import *\n'
    'import string\nimport re\nimport datetime\nimport collections\nimport heapq\nimport bisect\nimport copy\n'
    'import math\nimport random\nimport statistics\nimport itertools\nimport functools\nimport operator\n'
    'import io\nimport sys\nimport json\nsys.setrecursionlimit(50000)\n'
)

# lcb_runner/evaluation/compute_code_generation_metrics.py sets this at
# import; -I ignores the environment variable that would.
INT_MAX_STR_DIGITS = 50000


class GradeTimeout(BaseException):
    """A test, or loading the answer, ran past its limit. The grader reads the name as fail_timeout."""


class CandidateError(Exception):
    """The answer did not load, define the method, or return on some test."""


class _Sink:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def _on_alarm(signum, frame):
    raise GradeTimeout()


def _clip(text: str) -> str:
    text = ' '.join(str(text).split())
    return text if len(text) <= 120 else text[:117] + '...'


def _short(value) -> str:
    try:
        return _clip(repr(value))
    except Exception as exc:  # an answer's own __repr__ can raise
        return f'<unrepresentable {type(value).__name__}: {exc}>'


def _why(exc: BaseException) -> str:
    if isinstance(exc, SystemExit):
        return f'SystemExit: the program exited ({exc.code!r}) before its tests finished'
    try:
        detail = str(exc)
    except Exception:
        detail = ''
    return f'{type(exc).__name__}: {_clip(detail)}' if detail else type(exc).__name__


def _limited(fn, args, seconds: float):
    """fn(*args) under an alarm, with the answer's printing discarded."""
    stdout = sys.stdout
    sys.stdout = _Sink()
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        try:
            return fn(*args)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        sys.stdout = stdout


def _limit_memory(limit: int) -> None:
    # LiveCodeBench sets no memory limit; this keeps a runaway answer from
    # pushing a served model's experts out of RAM. Best effort.
    try:
        import resource

        _, hard = resource.getrlimit(resource.RLIMIT_AS)
        if hard != resource.RLIM_INFINITY:
            limit = min(limit, hard)
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
    except (ImportError, ValueError, OSError):
        pass


def grade(code: str, func_name: str, tests: list[dict], timeout: float) -> None:
    """Return when every test matches; raise GradeTimeout, CandidateError or AssertionError otherwise."""
    sys.set_int_max_str_digits(INT_MAX_STR_DIGITS)
    signal.signal(signal.SIGALRM, _on_alarm)
    source = IMPORT_STRING + '\n\n' + code
    module = types.ModuleType('tmp_sol', '')
    try:
        _limited(exec, (compile(source, '<answer>', 'exec', dont_inherit=True), module.__dict__), timeout)
        compiled = module.Solution() if 'class Solution' in source else module
    except GradeTimeout:
        raise GradeTimeout(f'the answer did not finish loading within {timeout:g} s') from None
    except BaseException as exc:
        raise CandidateError(f'the answer did not load: {_why(exc)}') from None
    method = getattr(compiled, func_name, None)
    if not callable(method):
        raise CandidateError(f'the answer defines no method named {func_name}')

    for i, test in enumerate(tests):
        args = [json.loads(line) for line in test['input'].split('\n')]
        expected = json.loads(test['output'])
        try:
            got = _limited(method, args, timeout)
        except GradeTimeout:
            raise GradeTimeout(f'test {i} ran past its {timeout:g} s limit') from None
        except BaseException as exc:
            raise CandidateError(f'test {i}: {_why(exc)}') from None
        # Don't penalize a tuple where the expected output is a list, as LiveCodeBench does not.
        if isinstance(got, tuple):
            got = list(got)
        if got != expected:
            raise AssertionError(f'test {i}: expected {_short(expected)}, got {_short(got)}')


def main(spec_json: str) -> None:
    spec = json.loads(spec_json)
    _limit_memory(int(spec['memory_limit_bytes']))
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, 'tests.json')) as f:
        tests = json.load(f)
    # The module is taken out of sys.modules first, so the answer cannot
    # reach grade()'s globals by name.
    sys.modules.pop('__graded__', None)
    grade(spec['code'], spec['func_name'], tests, float(spec['timeout']))
