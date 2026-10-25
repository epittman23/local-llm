"""HumanEval+ and MBPP+: the vendored data, and grading it the way EvalPlus does.

The runtime's pieces are checked directly (allclose against numpy, every
special oracle, the MBPP+ input rules), and whole items go through grade(),
the path a model answer takes: a subprocess per item, with the dataset's own
inputs and live expected outputs.

Run from apps/server:

    python -m pytest tests/test_evalplus.py
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import json
import math
import random
import re
import subprocess
import time
import uuid

import numpy as np
import pytest

from local_llm.benchmarks.evaluation import adapters, datasets, grading
from local_llm.benchmarks.evaluation.adapters import load_adapters, render_prompt
from local_llm.benchmarks.evaluation.datasets import DatasetError, dataset_identity, read_items
from local_llm.benchmarks.evaluation.grading import FAIL_ASSERT, FAIL_ERROR, FAIL_TIMEOUT, PASS, grade
from local_llm.benchmarks.evaluation.grading import evalplus_runtime as rt

CHECK = {'harness': 'evalplus', 'min_time_limit': 1.0, 'time_limit_factor': 4.0, 'cap': 20, 'memory_limit_gib': 4}
HUMANEVAL = {'check': {**CHECK, 'dataset': 'humaneval', 'isolated': True}}
MBPP = {'check': {**CHECK, 'dataset': 'mbpp', 'isolated': True}}

SQUARE = {
    'task_id': 'HumanEval/x',
    'entry_point': 'square',
    'prompt': 'def square(x: int) -> int:\n    """x squared."""\n',
    'canonical_solution': '    return x * x\n',
    'atol': 0,
    'base_input': [[1], [2], [3]],
    'plus_input': [[-7], [10**6]],
}


def fenced(code: str) -> str:
    return f'```python\n{code}\n```\n'


def item(**overrides) -> dict:
    return {**copy.deepcopy(SQUARE), **overrides}


def _alive(marker: str) -> bool:
    time.sleep(0.3)
    return subprocess.run(['pgrep', '-f', marker], capture_output=True).returncode == 0


# --- the vendored data ------------------------------------------------------------------------


@pytest.mark.parametrize(
    'bench, n, release', [('humanevalplus', 164, 'v0.1.10'), ('mbppplus', 378, 'v0.2.0'), ('ds1000', 1000, '4416080a')]
)
def test_each_vendored_dataset_loads_verified_with_its_release(bench, n, release):
    identity = dataset_identity(bench)
    assert identity is not None and identity['vendored']
    assert identity['n_items'] == n == len(read_items(bench))
    # DS-1000 pins the revision its fetched rows carried; see the test below.
    expected = identity['content_sha256'][:12]
    assert identity['revision'] in (f'{release}@{expected}', '4416080ac5cb80bdf7576aefb8f9a0b4d5426a44')
    assert identity['revision'].startswith(release)


def test_the_pinned_hash_is_of_the_decompressed_rows():
    source = load_adapters()['humanevalplus']['source']
    raw = gzip.decompress(datasets.vendored_path(source).read_bytes())
    assert hashlib.sha256(raw).hexdigest() == source['sha256']


def _vendored_copy(tmp_path, monkeypatch, rows: bytes) -> None:
    """Point a one-adapter directory at a vendored file of these bytes."""
    adapter_dir, data = tmp_path / 'adapters', tmp_path / 'datasets'
    adapter_dir.mkdir()
    (data / 'x').mkdir(parents=True)
    (data / 'x' / 'x.jsonl.gz').write_bytes(gzip.compress(rows))
    pinned = hashlib.sha256(b'{"task_id": "x/0"}\n').hexdigest()
    (adapter_dir / 'x.toml').write_text(
        'id = "x"\nprompt_template = "{prompt}"\n'
        f'[source]\nkind = "vendored"\nrelease = "r1"\npath = "x/x.jsonl.gz"\nsha256 = "{pinned}"\n'
        '[item]\nid_field = "task_id"\nprompt_field = "prompt"\n[check]\nharness = "evalplus"\n'
    )
    monkeypatch.setattr(adapters, 'ADAPTERS_DIR', adapter_dir)
    monkeypatch.setattr(datasets, 'DATASETS_DIR', data)


def test_a_vendored_file_that_matches_its_pin_is_read(tmp_path, monkeypatch):
    _vendored_copy(tmp_path, monkeypatch, b'{"task_id": "x/0"}\n')
    assert read_items('x') == [{'task_id': 'x/0'}]


def test_a_tampered_vendored_file_is_refused(tmp_path, monkeypatch):
    _vendored_copy(tmp_path, monkeypatch, b'{"task_id": "x/1"}\n')
    with pytest.raises(DatasetError, match='does not match its pinned hash'):
        read_items('x')
    with pytest.raises(DatasetError, match='does not match its pinned hash'):
        dataset_identity('x')


def test_a_vendored_path_outside_the_datasets_directory_is_refused():
    with pytest.raises(DatasetError, match='outside'):
        datasets.vendored_path({'path': '../adapters/ds1000.toml'})


def test_fetching_a_vendored_dataset_downloads_nothing(tmp_path):
    identity = datasets.fetch_one(load_adapters()['mbppplus'], base=tmp_path)
    assert identity['vendored'] and identity['n_items'] == 378
    assert list(tmp_path.iterdir()) == []


def test_a_calibration_of_other_rows_is_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(grading, 'env_fingerprint', lambda: {'python': 'test'})
    identity = dataset_identity('mbppplus')
    assert identity is not None
    record = {
        'content_sha256': identity['content_sha256'],
        'environment': {'python': 'test'},
        'harness_version': grading.HARNESS_VERSION,
    }
    grading.write_calibration('mbppplus', record, tmp_path)
    assert grading.calibration_stale('mbppplus', tmp_path) == ''
    grading.write_calibration('mbppplus', {**record, 'content_sha256': 'f' * 64}, tmp_path)
    assert grading.calibration_stale('mbppplus', tmp_path) == 'the dataset changed since it was calibrated'


# --- the prompt -------------------------------------------------------------------------------


@pytest.mark.parametrize('bench', ['humanevalplus', 'mbppplus'])
def test_the_prompt_is_evalplus_s_own_byte_for_byte(bench):
    adapter = load_adapters()[bench]
    row = read_items(bench)[0]
    expected = (
        'Please provide a self-contained Python script that solves the following problem in a markdown code block:'
        + f'\n```python\n{row["prompt"].strip()}\n```'
    )
    assert render_prompt(adapter, row) == expected


# --- allclose is numpy's ----------------------------------------------------------------------


# (result, raised): numpy raises its own TypeError subclasses, so only whether
# each side raised is compared, not the class.
def _numpy_allclose(a, b, rtol, atol):
    try:
        return bool(np.allclose(a, b, rtol=rtol, atol=atol)), False
    except Exception:
        return None, True


def _ours(a, b, rtol, atol):
    try:
        return rt.allclose(a, b, rtol=rtol, atol=atol), False
    except Exception:
        return None, True


ALLCLOSE_CASES = [
    (1.0, 1.0 + 1e-9),
    (1.0, 1.1),
    ([1.0, 2.0], [1.0, 2.0000001]),
    ([1.0, 2.0], [1.0, 2.1]),
    ([[1.0, 2.0], [3.0, 4.0]], [[1.0, 2.0], [3.0, 4.0 + 1e-12]]),
    ([[1.0], [2.0]], [[1.0, 1.0], [2.0, 2.0]]),  # broadcasts
    ([1.0, 2.0], 1.0),
    ([], []),
    (float('inf'), float('inf')),
    (float('inf'), float('-inf')),
    (float('nan'), float('nan')),
    ([True, False], [1.0, 0.0]),
    (1 + 2j, 1 + 2.0000001j),
    (3, 3.0000001),
]
ALLCLOSE_REFUSED = [
    (['a'], ['a']),
    ([None], [None]),
    ([[1.0], [1.0, 2.0]], [[1.0], [1.0, 2.0]]),  # ragged
    ([1.0, 2.0, 3.0], [1.0, 2.0]),  # shapes that do not broadcast
    ({'a': 1.0}, {'a': 1.0}),
]


@pytest.mark.parametrize('a, b', ALLCLOSE_CASES)
def test_allclose_agrees_with_numpy(a, b):
    for atol in (0.0, 1e-6, 1e-4):
        assert _ours(a, b, 1e-07, atol) == _numpy_allclose(a, b, 1e-07, atol)


@pytest.mark.parametrize('a, b', ALLCLOSE_REFUSED)
def test_allclose_refuses_what_numpy_refuses(a, b):
    assert _ours(a, b, 1e-07, 1e-6)[0] is None
    assert _numpy_allclose(a, b, 1e-07, 1e-6)[0] is None


def _float_tasks() -> list[tuple[str, dict]]:
    rows = [('humaneval', r) for r in read_items('humanevalplus')] + [('mbpp', r) for r in read_items('mbppplus')]
    return [(d, r) for d, r in rows if r['atol'] != 0 and r['entry_point'] != 'find_zero']


def _perturb(value, scale: float):
    if isinstance(value, float):
        return value * (1 + scale) + scale
    if isinstance(value, (list, tuple)):
        return type(value)(_perturb(v, scale) for v in value)
    return value


def test_allclose_agrees_with_numpy_on_every_float_task_s_real_outputs():
    tasks = _float_tasks()
    assert len(tasks) >= 14
    compared = 0
    for dataset, row in tasks:
        namespace: dict = {}
        exec(row['prompt'] + row['canonical_solution'], namespace)  # the dataset's own trusted solution
        fn = namespace[row['entry_point']]
        inputs = row['base_input'] + row['plus_input']
        if dataset == 'mbpp':
            inputs = rt.mbpp_deserialize_inputs(row['task_id'], inputs)
        for inp in inputs[:40]:
            try:
                out = fn(*copy.deepcopy(inp))
            except Exception:
                continue
            for scale in (0.0, 1e-9, 1e-6, 1e-3):
                other = _perturb(out, scale)
                assert _ours(other, out, 1e-07, row['atol']) == _numpy_allclose(other, out, 1e-07, row['atol']), (
                    row['task_id'],
                    inp,
                    scale,
                )
                compared += 1
    assert compared > 1000


def test_allclose_agrees_with_numpy_on_random_arrays():
    rng = random.Random(20261025)
    for _ in range(500):
        shape = [rng.randint(0, 3) for _ in range(rng.randint(0, 3))]

        def build(dims):
            if not dims:
                return rng.choice([rng.uniform(-1e3, 1e3), rng.randint(-5, 5), float('inf'), 0.0])
            return [build(dims[1:]) for _ in range(dims[0])]

        a = build(shape)
        b = _perturb(a, rng.choice([0.0, 1e-8, 1e-5]))
        assert _ours(a, b, 1e-07, 1e-6) == _numpy_allclose(a, b, 1e-07, 1e-6)


# --- the oracles ------------------------------------------------------------------------------


def test_is_floats_follows_evalplus():
    assert rt.is_floats(1.0) and rt.is_floats([1.0, 2.0]) and rt.is_floats((1.0,))
    assert not rt.is_floats([]) and not rt.is_floats([1.0, 2]) and not rt.is_floats(1)


def test_a_float_output_makes_atol_one_millionth_for_the_rest_of_the_set():
    ok, atol = rt.check_output('mbpp', 'f', [1], 0.30000000000000004, 0.3, 0)
    assert ok and atol == 1e-6
    # It stays 1e-6 for the next input, where an int against a float fails the type check.
    assert rt.check_output('mbpp', 'f', [1], 1000000, 1000000.0000001, atol) == (False, 1e-6)
    assert rt.check_output('mbpp', 'f', [1], 2.0, 2.0000001, 1e-6)[0]


def test_a_type_or_length_mismatch_fails_before_allclose():
    assert not rt.check_output('mbpp', 'f', [1], (1.0, 2.0), [1.0, 2.0], 1e-4)[0]
    assert not rt.check_output('mbpp', 'f', [1], [1.0], [1.0, 2.0], 1e-4)[0]


def test_set_equality_tasks_ignore_order_and_duplicates():
    assert rt.check_output('mbpp', 'similar_elements', [(3, 4), (4, 3)], (4, 3), (3, 4), 0)[0]
    assert not rt.check_output('mbpp', 'similar_elements', [(3, 4), (4, 3)], (4,), (3, 4), 0)[0]


def test_not_none_tasks_compare_presence():
    assert rt.check_output('mbpp', 'check_str', ['a'], object(), True, 0)[0]
    assert rt.check_output('mbpp', 'check_str', ['a'], None, False, 0)[0]
    assert not rt.check_output('mbpp', 'check_str', ['a'], None, True, 0)[0]
    assert rt.check_output('mbpp', 'check_str', ['a'], True, True, 0)[0]


def test_the_mbpp_special_oracles():
    assert rt.check_output('mbpp', 'are_equivalent', [1, 2], 'anything', False, 0)[0]  # Mbpp/164
    assert rt.check_output('mbpp', 'sum_div', [1], 0, 5, 0)[0]  # Mbpp/295
    assert not rt.check_output('mbpp', 'sum_div', [1], 4, 5, 0)[0]
    assert rt.check_output('mbpp', 'surface_Area', [3, 4], rt._surface_Area(3, 4), 1, 1e-4)[0]  # Mbpp/581
    assert rt.check_output('mbpp', 'digit_distance_nums', [123, 7], rt._digit_distance_nums(123, 7), -1, 0)[
        0
    ]  # Mbpp/558


def test_find_zero_accepts_any_root():
    xs = [-6, 11, -6, 1]  # (x - 1)(x - 2)(x - 3)
    for root in (1.0, 2.0, 3.0):
        assert rt.check_output('humaneval', 'find_zero', [xs], root, 1.0, 1e-4)[0]
    assert not rt.check_output('humaneval', 'find_zero', [xs], 1.5, 1.0, 1e-4)[0]
    assert math.isclose(rt._poly(xs, 2.0), 0.0, abs_tol=1e-12)


@pytest.mark.parametrize(
    'task, raw, check',
    [
        ('Mbpp/2', [[[3, 4], [5, 6]]], lambda r: all(isinstance(a, tuple) for a in r[0])),
        ('Mbpp/63', [[[[1, 2], [3, 4]]]], lambda r: isinstance(r[0][0][0], tuple)),
        ('Mbpp/75', [[[[1, 2]], 3]], lambda r: isinstance(r[0][0][0], tuple) and r[0][1] == 3),
        ('Mbpp/106', [[[1], [2, 3]]], lambda r: r[0][0] == [1] and r[0][1] == (2, 3)),
        ('Mbpp/115', [[[[1], []]]], lambda r: r[0][0] == [{1}, {}] and type(r[0][0][1]) is dict),
        ('Mbpp/124', [['1.5', '(1+2j)']], lambda r: r[0] == (1.5, 1 + 2j)),
        ('Mbpp/250', [[[1, 2], 3]], lambda r: r[0] == [(1, 2), 3]),
        ('Mbpp/259', [[[[1, 2]], [[3, 4]]]], lambda r: r[0] == [((1, 2),), ((3, 4),)]),
        ('Mbpp/278', [[[1, [2, 3]]]], lambda r: r[0] == [(1, (2, 3))]),
        ('Mbpp/307', [[[1, 2], 3, 4]], lambda r: r[0] == [(1, 2), 3, 4]),
        ('Mbpp/722', [[{'a': [1, 2]}, 3]], lambda r: r[0] == [{'a': (1, 2)}, 3]),
        ('Mbpp/252', [['(1+2j)']], lambda r: r[0] == [1 + 2j]),
        ('Mbpp/580', [[1, [2, [3]]]], lambda r: r[0] == (1, (2, (3,)))),
        ('Mbpp/3', [[[1, 2]]], lambda r: r[0] == [[1, 2]]),  # not special: unchanged
    ],
)
def test_mbpp_inputs_are_deserialized_as_evalplus_does(task, raw, check):
    assert check(rt.mbpp_deserialize_inputs(task, raw))


def test_the_special_cased_mbpp_tasks_present_get_tuples_back():
    rows = {r['task_id']: r for r in read_items('mbppplus')}
    inputs = rt.mbpp_deserialize_inputs('Mbpp/2', rows['Mbpp/2']['base_input'])
    assert all(isinstance(arg, tuple) for inp in inputs for arg in inp)


# --- whole items, through grade() ---------------------------------------------------------------


def test_a_correct_answer_passes_on_base_and_plus_inputs():
    assert grade(HUMANEVAL, item(), fenced('def square(x):\n    return x ** 2')) == (PASS, '')


def test_a_completion_style_body_gets_the_stub():
    assert grade(HUMANEVAL, item(), fenced('    return x * x')) == (PASS, '')


def test_a_wrong_answer_fails_on_a_base_input():
    outcome, reason = grade(HUMANEVAL, item(), fenced('def square(x):\n    return x + x'))
    assert outcome == FAIL_ASSERT and 'base input 0' in reason


def test_an_answer_wrong_only_on_a_plus_input_fails_and_says_so():
    code = 'def square(x):\n    return x * x if x > 0 else 0'
    outcome, reason = grade(HUMANEVAL, item(), fenced(code))
    assert outcome == FAIL_ASSERT and 'plus input 0' in reason and 'expected 49, got 0' in reason


def test_an_answer_that_raises_is_an_error_naming_the_input():
    outcome, reason = grade(
        HUMANEVAL, item(), fenced('def square(x):\n    if x == 3:\n        raise ValueError("no")\n    return x * x')
    )
    assert outcome == FAIL_ERROR and 'base input 2: ValueError: no' in reason


def test_an_answer_without_the_function_is_an_error():
    outcome, reason = grade(MBPP, item(task_id='Mbpp/9999'), fenced('def cube(x):\n    return x ** 3'))
    assert outcome == FAIL_ERROR and 'no function named square' in reason


def test_a_slow_but_correct_answer_passes_under_the_floor():
    code = 'import time\ndef square(x):\n    time.sleep(0.2)\n    return x * x'
    assert grade(HUMANEVAL, item(), fenced(code)) == (PASS, '')


def test_an_infinite_loop_times_out_on_its_input_and_leaves_nothing_running():
    marker = f'evalplus-sleeper-{uuid.uuid4().hex}'
    code = (
        'import subprocess, sys\n'
        'def square(x):\n'
        f"    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)', '{marker}'],"
        ' stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n'
        '    while True:\n        pass\n'
        '    return x\n'
    )
    started = time.monotonic()
    outcome, reason = grade(HUMANEVAL, item(), fenced(code))
    assert outcome == FAIL_TIMEOUT and 'base input 0 ran past its 1.00 s limit' in reason
    assert time.monotonic() - started < 15
    assert not _alive(marker)


def test_an_answer_that_catches_the_alarm_still_times_out():
    code = (
        'import time\n'
        'def square(x):\n'
        '    try:\n        time.sleep(30)\n'
        '    except BaseException:\n        pass\n'
        '    return x * x\n'
    )
    assert grade(HUMANEVAL, item(), fenced(code))[0] == FAIL_TIMEOUT


def test_the_item_cap_bounds_an_answer_slow_on_every_input():
    # Ten inputs at 0.9 s each fit their 1 s limits but not a 3 s cap.
    check = {**HUMANEVAL['check'], 'cap': 3}
    code = 'import time\ndef square(x):\n    time.sleep(0.9)\n    return x * x'
    outcome, reason = grade({'check': check}, item(plus_input=[[i] for i in range(10)]), fenced(code))
    assert outcome == FAIL_TIMEOUT, reason


def test_an_answer_over_the_memory_limit_fails():
    check = {**HUMANEVAL['check'], 'memory_limit_gib': 1}
    code = 'def square(x):\n    return len(bytearray(4 * 2**30)) and x * x'
    outcome, reason = grade({'check': check}, item(), fenced(code))
    assert outcome == FAIL_ERROR and 'MemoryError' in reason


@pytest.mark.parametrize(
    'code',
    [
        'import sys\nSTOP = sys.exit(0)\ndef square(x):\n    return x * x + 0 * STOP',
        'import sys\ndef square(x):\n    sys.exit(0)\n    return x',
        'import os\ndef square(x):\n    os._exit(0)\n    return x',
    ],
    ids=['exit at load', 'exit in the call', 'os._exit in the call'],
)
def test_an_answer_that_exits_early_fails(code):
    outcome, reason = grade(HUMANEVAL, item(), fenced(code))
    assert outcome == FAIL_ERROR and 'before its tests finished' in reason


def test_an_answer_cannot_patch_the_comparison():
    code = (
        'import sys\n'
        'def square(x):\n'
        "    graded = sys.modules.get('__graded__')\n"
        '    if graded is not None:\n'
        '        graded.check_output = lambda *a: (True, 0)\n'
        '    return 0\n'
    )
    assert grade(HUMANEVAL, item(), fenced(code))[0] == FAIL_ASSERT


def test_the_answer_s_printing_does_not_reach_the_verdict():
    code = 'def square(x):\n    print("x" * 10000)\n    return x * x'
    assert grade(HUMANEVAL, item(), fenced(code)) == (PASS, '')


def test_a_failing_reference_is_reported_as_the_reference_s():
    broken = item(canonical_solution='    return 1 // (x - 2)\n')
    outcome, reason = grade(HUMANEVAL, broken, fenced('def square(x):\n    return x * x'))
    assert outcome == FAIL_ERROR and 'the reference solution failed: ZeroDivisionError' in reason


def test_an_mbpp_not_none_task_compares_presence_end_to_end():
    row = {
        'task_id': 'Mbpp/9999',
        'entry_point': 'check_str',
        'prompt': '"""\nMatch strings starting with a vowel.\n"""\n',
        'canonical_solution': 'import re\ndef check_str(s):\n    return re.search(r"^[aeiou]", s)\n',
        'atol': 0,
        'base_input': [['apple'], ['pear']],
        'plus_input': [['orange']],
    }
    assert grade(MBPP, row, fenced('def check_str(s):\n    return s[:1] in "aeiou" or None')) == (PASS, '')
    assert grade(MBPP, row, fenced('def check_str(s):\n    return None'))[0] == FAIL_ASSERT


@pytest.mark.parametrize('bench', ['humanevalplus', 'mbppplus'])
def test_a_sample_of_real_canonical_solutions_passes(bench):
    adapter = load_adapters()[bench]
    rows = [r for r in read_items(bench) if r['task_id'] not in ('HumanEval/32', 'Mbpp/630')]
    for row in random.Random(7).sample(rows, 6):
        assert grade(adapter, row, grading.reference_answer(adapter, row)) == (PASS, ''), row['task_id']


def test_humaneval_32_s_reference_misses_evalplus_s_own_tolerance():
    # Recorded in the benchmarks guide: calibration excludes this item, because
    # its canonical solution's root on plus input 119 leaves |p(x)| = 0.0023,
    # above the task's atol of 1e-4.
    adapter = load_adapters()['humanevalplus']
    row = next(r for r in read_items('humanevalplus') if r['task_id'] == 'HumanEval/32')
    outcome, reason = grade(adapter, row, grading.reference_answer(adapter, row))
    assert outcome == FAIL_ASSERT and 'plus input 119' in reason


def test_the_subprocess_deadline_is_the_cap_plus_start_up():
    check = load_adapters()['humanevalplus']['check']
    assert grading.evalplus.subprocess_timeout(check) == check['cap'] + 5


def test_a_grade_timeout_line_is_fail_timeout():
    program = 'class GradeTimeout(BaseException):\n    pass\nraise GradeTimeout("input 3 ran past its 1.00 s limit")\n'
    assert grading.run_program(program, timeout=20, isolated=True) == (
        FAIL_TIMEOUT,
        '__graded__.GradeTimeout: input 3 ran past its 1.00 s limit',
    )


def test_any_prompt_and_answer_survive_being_written_into_the_program():
    # Quotes, backslashes and characters outside the BMP, in the reference
    # (through the prompt) and in the answer.
    row = item(prompt='def square(x: int) -> int:\n    """Caf\u00e9 \U0001f600 \'\\ "x"."""\n')
    answer = 'def square(x):\n    s = "\U0001f600\\\\\'"\n    return x * x'
    program = grading.evalplus.build_program(row, answer, HUMANEVAL['check'])
    assert program is not None
    compile(program, '<graded>', 'exec')
    assert grade(HUMANEVAL, row, fenced(answer)) == (PASS, '')


# --- grade() in this process ------------------------------------------------------------------
#
# The program normally runs grade() in the grading subprocess, where coverage
# cannot see it. It is an ordinary function, so these call it directly, with
# the address-space limit switched off (it would apply to the test run) and
# SIGALRM's handler put back afterwards.


@pytest.fixture
def in_process(monkeypatch):
    import signal
    import sys

    monkeypatch.setattr(rt, '_limit_memory', lambda limit: None)
    previous = signal.getsignal(signal.SIGALRM)
    module = sys.modules.get('__graded__')
    yield
    signal.setitimer(signal.ITIMER_REAL, 0)
    signal.signal(signal.SIGALRM, previous)
    if module is not None:
        sys.modules['__graded__'] = module


def _spec(row: dict, dataset: str = 'humaneval', **check) -> dict:
    return {
        'dataset': dataset,
        'task_id': row['task_id'],
        'entry_point': row['entry_point'],
        'atol': row['atol'],
        'base_input': row['base_input'],
        'plus_input': row['plus_input'],
        'min_time_limit': 0.2,
        'time_limit_factor': 4.0,
        'cap': 10,
        'memory_limit_bytes': 2**30,
        **check,
    }


REFERENCE = SQUARE['prompt'] + SQUARE['canonical_solution']


def test_in_process_a_correct_answer_returns(in_process):
    rt.main(json.dumps(_spec(SQUARE)), 'def square(x):\n    return x ** 2', REFERENCE)


def test_in_process_a_wrong_answer_raises_an_assertion_naming_the_input(in_process):
    with pytest.raises(AssertionError, match=r'plus input 0: expected 49, got 0'):
        rt.grade(_spec(SQUARE), 'def square(x):\n    return x * x if x > 0 else 0', REFERENCE)


@pytest.mark.parametrize(
    'answer, message',
    [
        ('def cube(x):\n    return x', 'no function named square'),
        ('def square(x):\n    return 1 / 0', 'base input 0: ZeroDivisionError'),
        ('def square(x)\n    return x', 'did not load: SyntaxError'),
        ('import sys\nSTOP = sys.exit(3)\ndef square(x):\n    return STOP', 'exited (3) before its tests finished'),
    ],
)
def test_in_process_a_broken_answer_raises_candidate_error(in_process, answer, message):
    with pytest.raises(rt.CandidateError, match=re.escape(message)):
        rt.grade(_spec(SQUARE), answer, REFERENCE)


def test_in_process_a_slow_input_raises_grade_timeout(in_process):
    with pytest.raises(rt.GradeTimeout, match=r'base input 0 ran past its 0\.20 s limit'):
        rt.grade(_spec(SQUARE), 'def square(x):\n    while True:\n        pass', REFERENCE)


def test_in_process_an_answer_that_swallows_the_alarm_still_times_out(in_process):
    answer = (
        'import time\n'
        'def square(x):\n'
        '    try:\n        time.sleep(5)\n'
        '    except BaseException:\n        pass\n'
        '    return x * x'
    )
    with pytest.raises(rt.GradeTimeout, match='ran past its'):
        rt.grade(_spec(SQUARE), answer, REFERENCE)


def test_in_process_a_slow_load_raises_grade_timeout(in_process):
    answer = 'FOREVER = sum(1 for _ in iter(int, 1))\ndef square(x):\n    return x * x + 0 * FOREVER'
    with pytest.raises(rt.GradeTimeout, match='did not finish loading'):
        rt.grade(_spec(SQUARE, min_time_limit=0.1, cap=1), answer, REFERENCE)


def test_in_process_the_item_budget_runs_out(in_process):
    row = item(plus_input=[[i] for i in range(20)])
    answer = 'import time\ndef square(x):\n    time.sleep(0.15)\n    return x * x'
    with pytest.raises(rt.GradeTimeout, match='budget'):
        rt.grade(_spec(row, cap=1), answer, REFERENCE)


@pytest.mark.parametrize(
    'reference, message',
    [
        (SQUARE['prompt'] + '    return 1 // (x - 2)\n', 'the reference solution failed: ZeroDivisionError'),
        (SQUARE['prompt'] + '    while True:\n        pass\n', 'took longer than the item cap'),
    ],
)
def test_in_process_a_failing_reference_raises_reference_failed(in_process, reference, message):
    with pytest.raises(rt.ReferenceFailed, match=message):
        rt.grade(_spec(SQUARE, cap=1), 'def square(x):\n    return x * x', reference)


def test_in_process_mbpp_inputs_are_deserialized_and_not_none_tasks_compared_by_presence(in_process):
    row = {
        'task_id': 'Mbpp/2',
        'entry_point': 'check_str',
        'atol': 0,
        'base_input': [[[1, 2], [3]]],
        'plus_input': [],
    }
    reference = 'def check_str(a, b):\n    assert isinstance(a, tuple) and isinstance(b, tuple)\n    return a\n'
    rt.grade(_spec(row, dataset='mbpp'), 'def check_str(a, b):\n    return object()', reference)
    with pytest.raises(AssertionError):
        rt.grade(_spec(row, dataset='mbpp'), 'def check_str(a, b):\n    return None', reference)


def test_in_process_the_answer_s_output_is_discarded(in_process, capsys):
    rt.grade(_spec(SQUARE), 'def square(x):\n    print("noise")\n    return x * x', REFERENCE)
    assert 'noise' not in capsys.readouterr().out


def test_an_unrepresentable_output_is_reported_without_raising():
    class Odd:
        def __repr__(self):
            raise RuntimeError('no repr')

    assert rt._short(Odd()).startswith('<unrepresentable Odd')
    assert rt._short('x' * 500).endswith('...') and len(rt._short('x' * 500)) == 120


def test_a_huge_integer_is_refused_as_numpy_refuses_it():
    assert _ours([2**70], [2**70 + 1], 1e-07, 1e-6) == (None, True)


# --- the rest of the loader ---------------------------------------------------------------------


def test_a_missing_vendored_file_is_a_dataset_error(tmp_path, monkeypatch):
    monkeypatch.setattr(datasets, 'DATASETS_DIR', tmp_path)
    with pytest.raises(DatasetError, match='is missing'):
        datasets._vendored_bytes({'path': 'nope.jsonl.gz', 'sha256': '0' * 64})


def test_an_adapter_with_neither_source_nor_fetch_cannot_be_fetched(tmp_path):
    with pytest.raises(DatasetError, match='neither a vendored'):
        datasets.fetch_one({'id': 'x', 'item': {}}, base=tmp_path)


def test_an_empty_answer_builds_no_program_and_an_item_without_a_solution_has_no_reference():
    assert grading.evalplus.build_program(SQUARE, '  \n', HUMANEVAL['check']) is None
    assert grading.evalplus.reference_answer({**SQUARE, 'canonical_solution': ''}) is None
    assert grading.build_program(HUMANEVAL, SQUARE, 'def square(x):\n    return x * x') is not None


# --- the answer is sanitized as EvalPlus sanitizes it -------------------------------------------


def test_a_correct_answer_with_a_wrong_self_test_passes():
    code = 'def square(x):\n    return x * x\n\nassert square(3) == 10\nprint(square(4))'
    assert grade(HUMANEVAL, item(), fenced(code)) == (PASS, '')


def test_sanitize_keeps_imports_and_what_the_entry_point_reaches():
    code = (
        'import math\n'
        'LIMIT = 10\n'
        'UNUSED = 1\n'
        'def helper(x):\n    return min(x, LIMIT)\n'
        'def square(x):\n    return helper(x) ** 2\n'
        'def other():\n    return 0\n'
        'print(square(2))\n'
    )
    assert rt.sanitize(code, 'square') == (
        'import math\nLIMIT = 10\ndef helper(x):\n    return min(x, LIMIT)\ndef square(x):\n    return helper(x) ** 2'
    )


def test_sanitize_keeps_the_first_definition_of_a_name():
    code = 'def square(x):\n    return 1\ndef square(x):\n    return x * x\n'
    assert rt.sanitize(code, 'square') == 'def square(x):\n    return 1'


def test_sanitize_drops_a_function_without_a_return_and_a_decorated_one():
    # EvalPlus's quirks: tree-sitter calls a decorated function a different
    # node type, which its sanitizer does not keep.
    code = 'import functools\n@functools.cache\ndef square(x):\n    return x * x\ndef noop():\n    pass\n'
    assert rt.sanitize(code, 'square') == 'import functools'


def test_code_extract_takes_the_longest_run_that_parses():
    text = 'Here is the code:\ndef f():\n    return 1\n\nx = f()\nThat is all.'
    assert rt.code_extract(text) == 'def f():\n    return 1\n\nx = f()'
    assert rt.code_extract('def f(:\n') == 'def f(:'


def test_an_answer_that_does_not_parse_falls_back_to_code_extract():
    assert rt.sanitize('def square(x):\n    return x * x\n)))', 'square') == 'def square(x):\n    return x * x'
    assert rt.extract_target_code_or_empty('(((', 'square') == ''


def test_mbpp_630_s_reference_loses_its_generator_helper_to_the_sanitizer():
    # Recorded in the benchmarks guide: EvalPlus keeps only functions with a
    # return statement, and the reference's helper `adjac` only yields. An
    # answer written the same way fails under EvalPlus too.
    adapter = load_adapters()['mbppplus']
    row = next(r for r in read_items('mbppplus') if r['task_id'] == 'Mbpp/630')
    outcome, reason = grade(adapter, row, grading.reference_answer(adapter, row))
    assert outcome == FAIL_ERROR and "name 'adjac' is not defined" in reason


# --- what changes for results already recorded -------------------------------------------------


def test_ds1000_keeps_the_revision_its_fetched_rows_were_recorded_under():
    # The vendored rows are the fetched ones, byte for byte, so its results stay
    # in the same Compare block as the ones recorded before vendoring.
    identity = dataset_identity('ds1000')
    assert identity is not None
    assert identity['revision'] == '4416080ac5cb80bdf7576aefb8f9a0b4d5426a44'
    assert datasets.short_revision(identity['revision']) == '4416080ac5cb'
    assert datasets.short_revision('v0.1.10@42526ec0e7d5') == 'v0.1.10@42526ec0e7d5'


class _Stop(Exception):
    pass


def _resume_with(monkeypatch, done: set) -> None:
    import asyncio

    from local_llm.benchmarks.evaluation import runner

    def select(*_a):
        return (
            {'id': 'smoke'},
            [{'benchmark': 'humanevalplus', 'item_id': 'HumanEval/0', 'adapter': {}, 'item': {}}],
            [],
        )

    async def context(session, **kwargs):
        return {'model': 'm', 'harness': None, 'suite_run_id': 'new'}

    async def latest(**kwargs):
        return 'old'

    async def completed(suite_run_id):
        assert suite_run_id == 'old'
        return done

    async def stop(*_a, **_k):
        raise _Stop()

    monkeypatch.setattr(runner, '_select', select)
    monkeypatch.setattr(runner, 'context', context)
    monkeypatch.setattr(runner.BenchmarkResults, 'latest_suite_run', latest)
    monkeypatch.setattr(runner.BenchmarkResults, 'completed', completed)
    monkeypatch.setattr(runner.BenchmarkSuiteExclusions, 'record_exclusions', stop)
    asyncio.run(runner.prepare_suite(None, suite_name='smoke', resume=True))


def test_resuming_a_run_recorded_under_a_replaced_benchmark_is_refused(monkeypatch):
    from local_llm.benchmarks.evaluation.runner import SuiteLoadError

    with pytest.raises(SuiteLoadError, match=r'no longer has \(humaneval\); start a new run'):
        _resume_with(monkeypatch, {('humaneval', 'HumanEval/0'), ('ds1000', '1')})


def test_resuming_a_run_of_current_benchmarks_goes_ahead(monkeypatch):
    with pytest.raises(_Stop):
        _resume_with(monkeypatch, {('humanevalplus', 'HumanEval/1'), ('ds1000', '1')})


def test_a_tampered_vendored_file_is_one_row_of_the_datasets_panel(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from local_llm.routers.benchmarks import tests as tests_router
    from local_llm.utils.auth import get_admin_user

    _vendored_copy(tmp_path, monkeypatch, b'{"task_id": "x/1"}\n')
    monkeypatch.setenv('BENCHMARKS_DATA_DIR', str(tmp_path / 'calibrations'))
    app = FastAPI()
    app.include_router(tests_router.router, prefix='/tests')
    app.dependency_overrides[get_admin_user] = lambda: object()
    with TestClient(app) as client:
        res = client.get('/tests/datasets')
    assert res.status_code == 200
    [row] = res.json()
    assert row['benchmark'] == 'x' and not row['fetched'] and row['vendored']
    assert 'does not match its pinned hash' in row['calibration_stale']
