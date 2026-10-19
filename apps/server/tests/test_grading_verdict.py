"""PASS means the program ran to its end, not that it exited 0 (#126), and a run leaves nothing behind (#142).

Each harness is exercised with an item shaped like its dataset's, through the
same grade() path a model answer takes.

Run from apps/server:

    python -m pytest tests/test_grading_verdict.py
"""

from __future__ import annotations

import json
import subprocess
import time
import uuid

import pytest

from local_llm.benchmarks.evaluation import grading
from local_llm.benchmarks.evaluation.grading import FAIL_ASSERT, FAIL_ERROR, FAIL_TIMEOUT, PASS, grade, run_program

HUMANEVAL = {'check': {'harness': 'humaneval', 'timeout': 20, 'isolated': True}}
MBPP = {'check': {'harness': 'mbpp', 'timeout': 20, 'isolated': True}}
DS1000 = {'check': {'harness': 'ds1000', 'timeout': 20, 'isolated': False}}

HUMANEVAL_ITEM = {
    'task_id': 'HumanEval/x',
    'entry_point': 'add',
    'prompt': 'def add(a: int, b: int) -> int:\n    """Sum of a and b."""\n',
    'canonical_solution': '    return a + b\n',
    'test': 'def check(candidate):\n    assert candidate(1, 2) == 3\n    assert candidate(-1, 1) == 0\n',
}
MBPP_ITEM = {
    'task_id': 1,
    'code': 'def add(a, b):\n    return a + b',
    'test_imports': ['import math'],
    'test_list': ['assert add(1, 2) == 3', 'assert add(-1, 1) == 0', 'assert math.isclose(add(0.1, 0.2), 0.3)'],
}
# DS-1000's code_context: the solution is exec'd into a test environment by
# test_execution, and test_string checks its surface form.
DS1000_ITEM = {
    'metadata': {'problem_id': 0},
    'reference_code': 'result = sum(values)',
    'code_context': (
        'def generate_test_case():\n'
        '    return [1, 2, 3], 6\n'
        '\n'
        'def test_execution(solution: str):\n'
        '    values, expected = generate_test_case()\n'
        "    test_env = {'values': values}\n"
        '    exec(solution, test_env)\n'
        "    assert test_env['result'] == expected\n"
        '\n'
        'def test_string(solution: str):\n'
        "    assert 'for ' not in solution, 'loops are not allowed'\n"
    ),
}


def fenced(code: str) -> str:
    return f'```python\n{code}\n```\n'


# --- the dataset's own solutions still pass -------------------------------------------------


@pytest.mark.parametrize(
    'adapter, item',
    [(HUMANEVAL, HUMANEVAL_ITEM), (MBPP, MBPP_ITEM), (DS1000, DS1000_ITEM)],
    ids=['humaneval', 'mbpp', 'ds1000'],
)
def test_reference_answers_pass(adapter, item):
    assert grade(adapter, item, grading.reference_answer(adapter, item)) == (PASS, '')


def test_wrong_answers_fail_on_the_datasets_assertions():
    assert grade(HUMANEVAL, HUMANEVAL_ITEM, fenced('def add(a, b):\n    return a - b'))[0] == FAIL_ASSERT
    assert grade(MBPP, MBPP_ITEM, fenced('def add(a, b):\n    return a * b'))[0] == FAIL_ASSERT
    assert grade(DS1000, DS1000_ITEM, fenced('result = max(values)'))[0] == FAIL_ASSERT
    # test_string's own verdict, after test_execution passed.
    assert grade(DS1000, DS1000_ITEM, fenced('result = 0\nfor v in values:\n    result += v'))[0] == FAIL_ASSERT


# --- exiting before the tests is a failure, not a pass (#126) -------------------------------

EARLY_EXITS = {
    'sys.exit(0)': 'import sys\ndef add(a, b):\n    return a - b\nsys.exit(0)',
    'unittest.main()': (
        'import unittest\ndef add(a, b):\n    return a - b\n'
        'class T(unittest.TestCase):\n    def test_nothing(self):\n        pass\nunittest.main()'
    ),
    'os._exit(0)': 'import os\ndef add(a, b):\n    return a - b\nos._exit(0)',
    'raise SystemExit': 'def add(a, b):\n    return a - b\nraise SystemExit',
}


@pytest.mark.parametrize('code', EARLY_EXITS.values(), ids=EARLY_EXITS.keys())
@pytest.mark.parametrize('adapter, item', [(HUMANEVAL, HUMANEVAL_ITEM), (MBPP, MBPP_ITEM)], ids=['humaneval', 'mbpp'])
def test_a_wrong_answer_that_exits_early_fails(adapter, item, code):
    outcome, reason = grade(adapter, item, fenced(code))
    assert outcome == FAIL_ERROR, (outcome, reason)
    assert 'before its tests finished' in reason


def test_a_correct_answer_with_a_main_block_that_reads_stdin_passes():
    code = (
        'def add(a, b):\n    return a + b\n\n'
        "if __name__ == '__main__':\n    a, b = map(int, input().split())\n    print(add(a, b))"
    )
    assert grade(HUMANEVAL, HUMANEVAL_ITEM, fenced(code)) == (PASS, '')
    assert grade(MBPP, MBPP_ITEM, fenced(code)) == (PASS, '')


def test_the_verdict_cannot_be_printed_by_the_program():
    # Anything the program can see: stdin is already /dev/null, and its own
    # source, arguments and environment carry no nonce.
    program = (
        'import os, sys\n'
        'print(sys.stdin.read())\n'
        "print(open(os.path.join(os.path.dirname(__file__), 'grade.py')).read())\n"
        'print(" ".join(sys.argv))\n'
        'print(os.environ)\n'
        'os._exit(0)\n'
    )
    assert run_program(program, timeout=20, isolated=True)[0] == FAIL_ERROR


def test_future_imports_in_the_driver_do_not_leak_into_the_program():
    program = 'def f(x: int): pass\nassert f.__annotations__["x"] is int\n'
    assert run_program(program, timeout=20, isolated=True) == (PASS, '')


# --- nothing the program starts outlives it (#142) -----------------------------------------


def _alive(marker: str) -> bool:
    time.sleep(0.3)
    return subprocess.run(['pgrep', '-f', marker], capture_output=True).returncode == 0


def _sleeper(marker: str, hold_stdout: bool) -> str:
    redirect = '' if hold_stdout else ', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL'
    return (
        'import subprocess, sys\n'
        f"subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)', '{marker}']{redirect})\n"
    )


def test_a_timeout_kills_what_the_program_forked():
    marker = f'grading-sleeper-{uuid.uuid4().hex}'
    program = _sleeper(marker, hold_stdout=False) + 'import time\ntime.sleep(60)\n'
    assert run_program(program, timeout=2, isolated=True)[0] == FAIL_TIMEOUT
    assert not _alive(marker)


def test_a_finished_run_kills_what_the_program_left_running():
    marker = f'grading-sleeper-{uuid.uuid4().hex}'
    assert run_program(_sleeper(marker, hold_stdout=False) + 'assert 1 + 1 == 2\n', timeout=20, isolated=True) == (
        PASS,
        '',
    )
    assert not _alive(marker)


def test_finished_tests_pass_even_when_a_child_holds_stdout_open():
    marker = f'grading-sleeper-{uuid.uuid4().hex}'
    started = time.monotonic()
    assert run_program(_sleeper(marker, hold_stdout=True) + 'assert 1 + 1 == 2\n', timeout=3, isolated=True) == (
        PASS,
        '',
    )
    assert time.monotonic() - started < 10
    assert not _alive(marker)


# --- a calibration from an older harness is stale -------------------------------------------


def test_a_calibration_made_by_another_harness_version_is_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(grading, 'env_fingerprint', lambda: {'python': '3.12.0'})
    monkeypatch.setattr(grading, 'read_manifest', lambda bench, base=None: {'content_sha256': 'abc'})
    record = {'content_sha256': 'abc', 'environment': {'python': '3.12.0'}, 'harness_version': grading.HARNESS_VERSION}
    grading.calibration_path('mbpp', tmp_path).parent.mkdir(parents=True)
    grading.calibration_path('mbpp', tmp_path).write_text(json.dumps(record))
    assert grading.calibration_stale('mbpp', tmp_path) == ''

    record['harness_version'] = grading.HARNESS_VERSION - 1
    grading.calibration_path('mbpp', tmp_path).write_text(json.dumps(record))
    assert 'grader changed' in grading.calibration_stale('mbpp', tmp_path)
    del record['harness_version']
    grading.calibration_path('mbpp', tmp_path).write_text(json.dumps(record))
    assert 'grader changed' in grading.calibration_stale('mbpp', tmp_path)
