"""LiveCodeBench: fetching and decoding increments, the release-date window, and grading both formats.

Nothing here touches the network or real LiveCodeBench data: increments are
synthetic files served from disk through file:// URLs, and payloads that try
to load a global are built here.

Run from apps/server:

    python -m pytest tests/test_livecodebench.py
"""

from __future__ import annotations

import base64
import copy
import datetime as dt
import hashlib
import json
import pickle
import time
import zlib

import pytest

from local_llm.benchmarks.evaluation import adapters, datasets, grading, livecodebench_data, suites
from local_llm.benchmarks.evaluation.datasets import DatasetError
from local_llm.benchmarks.evaluation.grading import (
    FAIL_ASSERT,
    FAIL_ERROR,
    FAIL_TIMEOUT,
    NO_CODE,
    PASS,
)
from local_llm.benchmarks.evaluation.grading import livecodebench as harness
from local_llm.benchmarks.evaluation.grading import livecodebench_runtime as rt

ADAPTER = adapters.load_adapters()['livecodebench']


def fenced(code: str) -> str:
    return f'Here it is.\n```python\n{code}\n```\n'


def _encode(tests: list[dict]) -> str:
    """LiveCodeBench's private_test_cases encoding: base64(zlib(pickle(json str)))."""
    return base64.b64encode(zlib.compress(pickle.dumps(json.dumps(tests)))).decode()


def _row(platform: str, qid: str, date: str, private: list[dict], **extra) -> dict:
    return {
        'question_title': f'{qid} title',
        'question_content': f'Solve {qid}.',
        'platform': platform,
        'question_id': qid,
        'contest_id': f'c-{qid[:3]}',
        'contest_date': f'{date}T00:00:00',
        'starter_code': extra.get('starter_code', ''),
        'difficulty': 'easy',
        'public_test_cases': json.dumps(extra.get('public', [{'input': '1', 'output': '2', 'testtype': 'stdin'}])),
        'private_test_cases': _encode(private),
        'metadata': json.dumps(extra.get('metadata', {})),
    }


# --- decoding -----------------------------------------------------------------------------------


def test_private_tests_decode_from_the_pickled_form_and_from_plain_json():
    tests = [{'input': '3\n', 'output': '9', 'testtype': 'stdin', 'extra': 'dropped'}]
    want = [{'input': '3\n', 'output': '9', 'testtype': 'stdin'}]
    assert livecodebench_data.decode_private_tests(_encode(tests)) == want
    assert livecodebench_data.decode_private_tests(json.dumps(tests)) == want


class _Evil:
    def __reduce__(self):
        import os

        return (os.system, ('echo pwned',))


def test_a_payload_that_loads_a_global_is_refused():
    payload = base64.b64encode(zlib.compress(pickle.dumps(_Evil()))).decode()
    with pytest.raises(pickle.UnpicklingError, match='refusing to load'):
        livecodebench_data.decode_private_tests(payload)


def test_a_payload_that_is_not_a_string_is_refused():
    payload = base64.b64encode(zlib.compress(pickle.dumps([1, 2, 3]))).decode()
    with pytest.raises(DatasetError, match='not a string'):
        livecodebench_data.decode_private_tests(payload)
    with pytest.raises(DatasetError, match='not a list of tests'):
        livecodebench_data.decode_private_tests(json.dumps({'input': 1}))


def test_a_payload_that_decompresses_too_far_is_refused(monkeypatch):
    monkeypatch.setattr(livecodebench_data, 'MAX_TESTS_BYTES', 64)
    with pytest.raises(DatasetError, match='size limit'):
        livecodebench_data.decode_private_tests(_encode([{'input': 'x' * 500, 'output': '', 'testtype': 'stdin'}]))


@pytest.mark.parametrize('platform, qid', [('AtCoder', 'abc1'), ('atcoder', '../etc'), ('atcoder', 'a/b'), ('', 'x')])
def test_ids_that_would_escape_the_tests_directory_are_refused(platform, qid):
    with pytest.raises(DatasetError, match='not a LiveCodeBench problem id'):
        livecodebench_data.decode_row(_row(platform, qid, '2025-01-01', []), 'test6.jsonl')


def test_a_row_becomes_an_item_and_its_private_tests():
    private = [{'input': '5', 'output': '25', 'testtype': 'stdin'}]
    item, tests = livecodebench_data.decode_row(
        _row('leetcode', '3708', '2025-01-11', private, metadata={'func_name': 'f'}), 'test6.jsonl'
    )
    assert item['id'] == 'leetcode/3708' and item['increment'] == 'test6.jsonl'
    assert item['metadata'] == {'func_name': 'f'} and item['public_test_cases'][0]['output'] == '2'
    assert tests == private


# --- fetching -----------------------------------------------------------------------------------


def _increment_file(tmp_path, name: str, rows: list[dict]) -> dict:
    raw = ''.join(json.dumps(r) + '\n' for r in rows).encode()
    (tmp_path / 'upstream').mkdir(exist_ok=True)
    (tmp_path / 'upstream' / name).write_bytes(raw)
    dates = sorted(r['contest_date'][:10] for r in rows)
    return {
        'name': name,
        'sha256': hashlib.sha256(raw).hexdigest(),
        'bytes': len(raw),
        'items': len(rows),
        'first': dates[0],
        'last': dates[-1],
    }


@pytest.fixture
def lcb(tmp_path, monkeypatch):
    """An adapter whose two increments are synthetic files, and a datasets directory of its own."""
    first = _increment_file(
        tmp_path,
        'test.jsonl',
        [
            _row('atcoder', 'abc100_a', '2024-01-10', [{'input': '2', 'output': '4', 'testtype': 'stdin'}]),
            _row('atcoder', 'abc101_a', '2024-03-01', []),
        ],
    )
    second = _increment_file(
        tmp_path,
        'test2.jsonl',
        [
            _row('atcoder', 'abc200_a', '2024-02-20', []),
            _row('leetcode', '3000', '2024-05-01', [], metadata={'func_name': 'f'}),
        ],
    )
    adapter = copy.deepcopy(ADAPTER)
    adapter['fetch']['increment'] = [first, second]
    base = tmp_path / 'datasets'
    monkeypatch.setenv('BENCHMARKS_DATA_DIR', str(base))
    monkeypatch.setattr(livecodebench_data, '_url', lambda a, name: (tmp_path / 'upstream' / name).as_uri())
    monkeypatch.setattr(adapters, 'load_adapters', lambda: {'livecodebench': adapter})
    return adapter


def test_fetching_an_increment_decodes_it_and_keeps_no_raw_file(lcb):
    messages: list[str] = []
    identity = livecodebench_data.fetch(lcb, ['test.jsonl'], progress=messages.append)
    root = livecodebench_data.bench_dir(lcb)
    assert sorted(p.name for p in root.iterdir()) == ['MANIFEST.json', 'test']
    assert not (root / 'test' / 'test.jsonl').exists()
    assert identity['n_items'] == 2 and identity['revision'] == lcb['fetch']['revision']
    assert [it['id'] for it in datasets.read_items('livecodebench')] == ['atcoder/abc100_a', 'atcoder/abc101_a']
    item = datasets.read_items('livecodebench')[0]
    assert livecodebench_data.private_tests(lcb, item) == [{'input': '2', 'output': '4', 'testtype': 'stdin'}]
    assert messages[-1] == 'test.jsonl: 2 problems from 2024-01-10 to 2024-03-01'
    assert datasets.dataset_identity('livecodebench')['n_items'] == 2


def test_increments_read_back_in_release_order_and_a_present_one_is_skipped(lcb):
    livecodebench_data.fetch(lcb, ['test2.jsonl'])
    livecodebench_data.fetch(lcb, ['test.jsonl'])
    messages: list[str] = []
    livecodebench_data.fetch(lcb, ['test.jsonl'], progress=messages.append)
    assert messages == ['test.jsonl: already downloaded']
    ids = [it['id'] for it in datasets.read_items('livecodebench')]
    assert ids == ['atcoder/abc100_a', 'atcoder/abc101_a', 'atcoder/abc200_a', 'leetcode/3000']
    assert sorted(livecodebench_data.present(lcb)) == ['test.jsonl', 'test2.jsonl']


def test_a_file_that_misses_its_pin_is_refused_and_nothing_is_kept(lcb):
    lcb['fetch']['increment'][0]['sha256'] = '0' * 64
    with pytest.raises(DatasetError, match='does not match its pinned hash'):
        livecodebench_data.fetch(lcb, ['test.jsonl'])
    assert list(livecodebench_data.bench_dir(lcb).iterdir()) == []


def test_a_cancelled_fetch_keeps_nothing(lcb):
    with pytest.raises(livecodebench_data.Cancelled):
        livecodebench_data.fetch(lcb, ['test.jsonl'], should_stop=lambda: True)
    assert list(livecodebench_data.bench_dir(lcb).iterdir()) == []
    with pytest.raises(DatasetError, match='not downloaded yet'):
        datasets.read_items('livecodebench')


def test_a_file_with_the_wrong_number_of_problems_is_refused(lcb):
    lcb['fetch']['increment'][0]['items'] = 3
    with pytest.raises(DatasetError, match='holds 2 problems, not the 3 pinned'):
        livecodebench_data.fetch(lcb, ['test.jsonl'])


def test_an_unknown_increment_is_refused_and_fetch_one_points_at_the_increments(lcb):
    with pytest.raises(DatasetError, match="no increment 'test9.jsonl'"):
        livecodebench_data.fetch(lcb, ['test9.jsonl'])
    with pytest.raises(DatasetError, match='fetched by increment'):
        datasets.fetch_one(lcb)


def test_missing_private_tests_are_a_dataset_error(lcb):
    item = {'platform': 'atcoder', 'question_id': 'abc1', 'increment': 'test.jsonl'}
    with pytest.raises(DatasetError, match='missing'):
        livecodebench_data.private_tests(lcb, item)
    with pytest.raises(DatasetError, match='not a LiveCodeBench problem id'):
        livecodebench_data.private_tests(lcb, {**item, 'question_id': '../x'})


# --- the window ---------------------------------------------------------------------------------


def test_parse_window():
    assert livecodebench_data.parse_window(None, None) is None
    assert livecodebench_data.parse_window('2025-01-05', None) == (dt.date(2025, 1, 5), None)
    assert livecodebench_data.window_text(livecodebench_data.parse_window('2025-01-05', '2025-02-01')) == (
        '2025-01-05..2025-02-01'
    )
    assert livecodebench_data.window_text((dt.date(2025, 1, 5), None)) == '2025-01-05..'
    with pytest.raises(ValueError, match='first date'):
        livecodebench_data.parse_window(None, '2025-01-01')
    with pytest.raises(ValueError, match='ends'):
        livecodebench_data.parse_window('2025-02-01', '2025-01-01')
    with pytest.raises(ValueError):
        livecodebench_data.parse_window('January', None)


def test_a_window_needs_every_increment_it_touches_including_overlapping_ones():
    def needed(lo, hi=None):
        return livecodebench_data.needed(ADAPTER, livecodebench_data.parse_window(lo, hi))

    assert needed('2025-01-05') == ['test6.jsonl']
    # test5 ends on the day test6 starts.
    assert needed('2025-01-04') == ['test5.jsonl', 'test6.jsonl']
    # test4 reaches back to 2023-08-26, so it overlaps every earlier increment.
    assert needed('2024-01-01', '2024-01-31') == ['test.jsonl', 'test4.jsonl']


def _suite(n: int = 8) -> dict:
    return {'id': 'smoke', 'seed': 1, 'benchmark': [{'id': 'livecodebench', 'n': n}]}


def test_without_a_window_a_tier_leaves_livecodebench_out_without_reading_it(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError('read without a window')

    monkeypatch.setattr(suites, 'read_items', boom)
    notes: list[str] = []
    assert suites.build_suite(_suite(), {'livecodebench': ADAPTER}, notes=notes) == ([], [])
    assert notes == ['livecodebench left out: no release-date window given']
    with pytest.raises(SystemExit, match='give its first date'):
        suites.build_suite(_suite(), {'livecodebench': ADAPTER}, only='livecodebench')


def test_a_window_needs_its_increments_fetched(lcb):
    window = livecodebench_data.parse_window('2024-02-01', None)
    with pytest.raises(SystemExit, match=r'needs test\.jsonl, test2\.jsonl, not fetched yet'):
        suites.build_suite(_suite(), {'livecodebench': lcb}, window=window)


def test_a_window_draws_its_pool_and_every_row_carries_it(lcb, monkeypatch):
    monkeypatch.setattr(grading, 'ungradeable', lambda bench, base=None: {})
    livecodebench_data.fetch(lcb, ['test.jsonl', 'test2.jsonl'])
    notes: list[str] = []
    window = livecodebench_data.parse_window('2024-02-01', '2024-04-30')
    selected, skipped = suites.build_suite(_suite(), {'livecodebench': lcb}, window=window, notes=notes)
    assert [r['item_id'] for r in selected] == ['atcoder/abc101_a', 'atcoder/abc200_a']
    assert {r['item_window'] for r in selected} == {'2024-02-01..2024-04-30'}
    assert notes == ['livecodebench: the window 2024-02-01..2024-04-30 holds 2 problems, fewer than 8; using all']
    with pytest.raises(SystemExit, match='no problems in the window'):
        suites.build_suite(
            _suite(), {'livecodebench': lcb}, window=livecodebench_data.parse_window('2024-06-01', '2024-06-02')
        )


def test_a_window_on_a_run_without_a_windowed_benchmark_is_refused(monkeypatch):
    monkeypatch.setattr(suites, 'read_items', lambda bench: [])
    plain = {'id': 'x', 'item': {'id_field': 'task_id', 'prompt_field': 'p'}}
    with pytest.raises(SystemExit, match='applies only to a windowed benchmark'):
        suites.build_suite(
            {'id': 'smoke', 'benchmark': [{'id': 'x', 'n': 1}]},
            {'x': plain},
            window=livecodebench_data.parse_window('2025-01-01', None),
        )


# --- the prompt ---------------------------------------------------------------------------------

# lcb_runner/prompts/code_generation.py at 28fef95e, as OpenAIReasonPreview sends it.
SYSTEM_MESSAGE_GENERIC = (
    'You are an expert Python programmer. You will be given a question (problem specification) and will '
    'generate a correct Python program that matches the specification and passes all tests.'
)
FORMATTING_MESSAGE_WITH_STARTER_CODE = (
    'You will use the following starter code to write the solution to the problem and enclose your code '
    'within delimiters.'
)
FORMATTING_WITHOUT_STARTER_CODE = (
    'Read the inputs from stdin solve the problem and write the answer to stdout (do not directly test on '
    'the sample inputs). Enclose your code within delimiters as follows. Ensure that when the python program '
    'runs, it reads the inputs, runs the algorithm and writes output to STDOUT.'
)


def _lcb_prompt(question: str, starter: str) -> str:
    prompt = f'### Question:\n{question}\n\n'
    if starter:
        prompt += f'### Format: {FORMATTING_MESSAGE_WITH_STARTER_CODE}\n'
        prompt += f'```python\n{starter}\n```\n\n'
    else:
        prompt += f'### Format: {FORMATTING_WITHOUT_STARTER_CODE}\n'
        prompt += '```python\n# YOUR CODE HERE\n```\n\n'
    prompt += '### Answer: (use the provided format with backticks)\n\n'
    return SYSTEM_MESSAGE_GENERIC + '\n\n' + prompt


@pytest.mark.parametrize('starter', ['', 'class Solution:\n    def f(self, x: int) -> int:\n        '])
def test_the_prompt_is_livecodebench_s_own_byte_for_byte(starter):
    item = {'question_content': 'Print {prompt} and {starter_code} literally.', 'starter_code': starter}
    assert adapters.render_prompt(ADAPTER, item) == _lcb_prompt(item['question_content'], starter)


def test_the_new_adapter_keys_leave_the_other_adapters_fingerprints_alone():
    shas = {name: a['_sha'] for name, a in adapters.load_adapters().items()}
    assert shas['ds1000'] == '762f7f29df54'
    assert shas['humanevalplus'] == '24f882de5aa9'
    assert shas['mbppplus'] == 'b0715cfe452d'


# --- grading ------------------------------------------------------------------------------------


def test_extract_code_takes_the_last_fenced_block_and_nothing_unfenced():
    assert harness.extract_code('```python\na = 1\n```\ntext\n```python\nb = 2\n```') == 'b = 2'
    assert harness.extract_code('print(1)') == ''


@pytest.mark.parametrize(
    'got, expected, ok',
    [
        ('3\n', '3', True),
        ('  1 2  \n3 \n\n', '1 2\n3', True),
        ('0.50', '0.5', True),
        ('1e2', '100', True),
        ('1 2', '1 3', False),
        ('abc', 'abd', False),
        ('1\n2', '1', False),
        ('50000000000000001', '50000000000000000', False),
    ],
)
def test_stdout_is_compared_as_livecodebench_compares_it(got, expected, ok):
    assert (harness.compare_stdout(got, expected) == '') is ok


def test_the_problem_timeout_is_livecodebench_s():
    assert harness.problem_timeout({'timeout_per_test': 6}, 10) == 75


def _graded(monkeypatch, item: dict, answer: str, private=(), **check):
    monkeypatch.setattr(livecodebench_data, 'private_tests', lambda adapter, it: list(private))
    adapter = {**ADAPTER, 'check': {**ADAPTER['check'], **check}}
    return grading.grade(adapter, item, answer)


STDIN_ITEM = {
    'id': 'atcoder/x',
    'platform': 'atcoder',
    'metadata': {},
    'public_test_cases': [{'input': '3\n', 'output': '9', 'testtype': 'stdin'}],
}
PRIVATE = [{'input': '12\n', 'output': '144', 'testtype': 'stdin'}]


@pytest.mark.parametrize(
    'code',
    [
        'x = int(input())\nprint(x * x)',
        'import sys\nx = int(sys.stdin.buffer.readline())\nprint(x * x)',
        'n = 0\ndef read():\n    global n\n    n = int(open(0).read())\nread()\nprint(n * n)',
        "def main():\n    print(int(input()) ** 2)\nif __name__ == '__main__':\n    main()",
        'print(int(input()) ** 2)\nexit(1)',
        'print(pow(int(input()), 2))\nprint(gcd(4, 6) - 2 or "")',
    ],
    ids=['input', 'stdin.buffer', 'global helper', 'main guard', 'exit after output', 'import header'],
)
def test_a_correct_stdin_answer_passes(monkeypatch, code):
    assert _graded(monkeypatch, STDIN_ITEM, fenced(code), PRIVATE) == (PASS, '')


def test_a_wrong_stdin_answer_fails_on_the_test_that_differs(monkeypatch):
    outcome, reason = _graded(monkeypatch, STDIN_ITEM, fenced('x = int(input())\nprint(9)'), PRIVATE)
    assert outcome == FAIL_ASSERT and reason == "test 1: wrong answer, line 0: got '9', expected '144'"


def test_a_crashing_stdin_answer_is_an_error(monkeypatch):
    outcome, reason = _graded(monkeypatch, STDIN_ITEM, fenced('raise ValueError("bad")'))
    assert outcome == FAIL_ERROR and reason == 'test 0: ValueError: bad'


def test_a_slow_stdin_answer_times_out(monkeypatch):
    outcome, reason = _graded(monkeypatch, STDIN_ITEM, fenced('while True:\n    pass'), timeout_per_test=1)
    assert outcome == FAIL_TIMEOUT and reason == 'test 0 ran past its 1 s limit'


def test_the_overall_limit_ends_a_problem(monkeypatch):
    monkeypatch.setattr(harness, 'problem_timeout', lambda check, n: 0)
    outcome, reason = _graded(monkeypatch, STDIN_ITEM, fenced('print(9)'))
    assert outcome == FAIL_TIMEOUT and 'overall limit' in reason


def test_an_answer_without_a_fenced_block_has_no_code(monkeypatch):
    assert _graded(monkeypatch, STDIN_ITEM, 'print(9)')[0] == NO_CODE


FUNC_ITEM = {
    'id': 'leetcode/x',
    'platform': 'leetcode',
    'metadata': {'func_name': 'pairUp'},
    'public_test_cases': [{'input': '[1, 2, 3]\n2', 'output': '[[1, 2], [3]]', 'testtype': 'functional'}],
}
FUNC_PRIVATE = [{'input': '[]\n3', 'output': '[]', 'testtype': 'functional'}]
SOLUTION = (
    'class Solution:\n'
    '    def pairUp(self, nums: List[int], k: int) -> List[List[int]]:\n'
    '        return [nums[i:i + k] for i in range(0, len(nums), k)]\n'
)


def test_a_correct_functional_answer_passes(monkeypatch):
    assert _graded(monkeypatch, FUNC_ITEM, fenced(SOLUTION), FUNC_PRIVATE) == (PASS, '')


def test_a_tuple_result_is_compared_as_a_list(monkeypatch):
    code = (
        'class Solution:\n'
        '    def pairUp(self, nums, k):\n'
        '        return tuple(nums[i:i + k] for i in range(0, len(nums), k))'
    )
    assert _graded(monkeypatch, FUNC_ITEM, fenced(code), FUNC_PRIVATE) == (PASS, '')


def test_a_module_level_function_is_called_when_there_is_no_solution_class(monkeypatch):
    code = 'def pairUp(nums, k):\n    return [nums[i:i + k] for i in range(0, len(nums), k)]'
    assert _graded(monkeypatch, FUNC_ITEM, fenced(code)) == (PASS, '')


@pytest.mark.parametrize(
    'code, outcome, reason',
    [
        ('class Solution:\n    def pairUp(self, nums, k):\n        return [nums]', FAIL_ASSERT, 'test 0: expected'),
        (
            'class Solution:\n    def pairUp(self, nums, k):\n        return 1 / 0',
            FAIL_ERROR,
            'test 0: ZeroDivisionError',
        ),
        ('class Solution:\n    def other(self):\n        pass', FAIL_ERROR, 'no method named pairUp'),
        (
            'class Solution:\n    def pairUp(self, nums, k):\n        while True:\n            pass',
            FAIL_TIMEOUT,
            'ran past',
        ),
        ('class Solution(:\n    pass', FAIL_ERROR, 'did not load: SyntaxError'),
    ],
    ids=['wrong', 'crash', 'no method', 'timeout', 'syntax error'],
)
def test_a_broken_functional_answer_fails_with_its_reason(monkeypatch, code, outcome, reason):
    got, why = _graded(monkeypatch, FUNC_ITEM, fenced(code), timeout_per_test=1)
    assert got == outcome and reason in why


def test_livecodebench_is_not_calibratable():
    assert not grading.calibratable(ADAPTER)
    assert grading.calibration_stale('livecodebench') == grading.NOT_CALIBRATABLE
    assert grading.reference_answer(ADAPTER, FUNC_ITEM) is None
    assert grading.ungradeable('livecodebench') == {}


# --- the functional runtime, in this process -----------------------------------------------------


@pytest.fixture
def in_process():
    import signal
    import sys

    previous = signal.getsignal(signal.SIGALRM)
    limit = sys.getrecursionlimit()
    digits = sys.get_int_max_str_digits()
    yield
    signal.setitimer(signal.ITIMER_REAL, 0)
    signal.signal(signal.SIGALRM, previous)
    sys.setrecursionlimit(limit)
    sys.set_int_max_str_digits(digits)


TESTS = FUNC_ITEM['public_test_cases'] + FUNC_PRIVATE


def test_in_process_a_correct_answer_returns(in_process):
    rt.grade(SOLUTION, 'pairUp', TESTS, 2)


def test_in_process_each_failure_raises_its_kind(in_process):
    with pytest.raises(AssertionError, match=r'test 0: expected \[\[1, 2\], \[3\]\], got \[\]'):
        rt.grade('def pairUp(nums, k):\n    return []', 'pairUp', TESTS, 2)
    with pytest.raises(rt.CandidateError, match='test 1: IndexError'):
        rt.grade(
            'def pairUp(nums, k):\n    return [nums[i:i + k] for i in range(0, len(nums), k)] if nums else [][0]',
            'pairUp',
            TESTS,
            2,
        )
    with pytest.raises(rt.CandidateError, match='before its tests finished'):
        rt.grade('def pairUp(nums, k):\n    raise SystemExit(2)', 'pairUp', TESTS, 2)
    with pytest.raises(rt.GradeTimeout, match='ran past its 0.2 s limit'):
        rt.grade('def pairUp(nums, k):\n    while True:\n        pass', 'pairUp', TESTS, 0.2)
    with pytest.raises(rt.GradeTimeout, match='did not finish loading'):
        rt.grade('while True:\n    pass', 'pairUp', TESTS, 0.2)
    with pytest.raises(rt.CandidateError, match='no method named pairUp'):
        rt.grade('x = 1', 'pairUp', TESTS, 2)


def test_in_process_an_unrepresentable_value_is_reported_without_raising():
    class Odd:
        def __repr__(self):
            raise RuntimeError('no')

    assert rt._short(Odd()).startswith('<unrepresentable Odd')
    assert rt._why(ValueError()) == 'ValueError'


# --- the Tests routes ---------------------------------------------------------------------------


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from local_llm.routers.benchmarks import tests as tests_router
    from local_llm.utils.auth import get_admin_user

    app = FastAPI()
    app.include_router(tests_router.router, prefix='/tests')
    app.dependency_overrides[get_admin_user] = lambda: object()
    return TestClient(app)


def _events(client) -> list[dict]:
    with client.stream('GET', '/tests/stream') as res:
        return [json.loads(line[6:]) for line in res.iter_lines() if line.startswith('data: ')]


@pytest.fixture
def router(lcb, monkeypatch):
    from local_llm.routers.benchmarks import tests as tests_router

    monkeypatch.setattr(tests_router, 'load_adapters', lambda: {'livecodebench': lcb})
    monkeypatch.setattr(tests_router, '_task', None)
    monkeypatch.setattr(tests_router, '_queue', None)
    monkeypatch.setattr(tests_router, '_cancel', False)
    monkeypatch.setattr(grading, 'env_fingerprint', lambda: {'python': 'test'})
    return tests_router


def test_options_list_each_increment_and_the_fetched_dates(router):
    livecodebench_data.fetch(router.load_adapters()['livecodebench'], ['test2.jsonl'])
    with _client() as client:
        windows = client.get('/tests/options').json()['windows']
    incs = windows['livecodebench']['increments']
    assert [(i['name'], i['fetched']) for i in incs] == [('test.jsonl', False), ('test2.jsonl', True)]
    assert windows['livecodebench']['date_range'] == ['2024-02-20', '2024-05-01']


def test_fetch_takes_the_increments_asked_for_and_none_by_default(router):
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['livecodebench']})
        idle = _events(client)
        client.post('/tests/fetch', json={'benchmarks': ['livecodebench'], 'increments': ['test.jsonl']})
        fetched = _events(client)
        status = client.get('/tests/datasets').json()
    assert idle[0]['message'] == 'no increments chosen, so none fetched'
    assert any(e.get('message', '').startswith('test.jsonl: downloading') for e in fetched)
    dataset = next(e for e in fetched if e['type'] == 'dataset')
    assert dataset['fetched'] and dataset['n_items'] == 2
    [row] = status
    assert row['fetched'] and row['n_items'] == 2 and row['calibration_stale'] == grading.NOT_CALIBRATABLE


def test_selfcheck_says_livecodebench_cannot_be_calibrated(router):
    with _client() as client:
        client.post('/tests/selfcheck', json={})
        events = _events(client)
    assert events[0] == {'type': 'progress', 'benchmark': 'livecodebench', 'message': grading.NOT_CALIBRATABLE}
    assert events[-1] == {'type': 'done', 'cancelled': False}


def test_a_bad_window_is_an_error_event(router):
    with _client() as client:
        client.post('/tests/run', json={'suite': 'smoke', 'window_min': '2025-02-01', 'window_max': '2025-01-01'})
        events = _events(client)
    assert events[-1]['type'] == 'error' and events[-1]['message'].startswith('bad release-date window')


# --- resuming and recording -----------------------------------------------------------------------


def _resume_patches(monkeypatch, row: dict, recorded: dict) -> None:
    from local_llm.benchmarks.evaluation import runner

    def select(*_a):
        return {'id': 'smoke'}, [row], []

    async def context(session, **kwargs):
        return {'model': 'm', 'harness': None, 'suite_run_id': 'new'}

    async def latest(**kwargs):
        return 'old'

    async def completed(suite_run_id):
        return {('livecodebench', 'atcoder/y')}

    async def windows_of(suite_run_id):
        return recorded

    monkeypatch.setattr(runner, '_select', select)
    monkeypatch.setattr(runner, 'context', context)
    monkeypatch.setattr(runner, 'load_adapters', lambda: {'livecodebench': ADAPTER, 'mbppplus': {}})
    monkeypatch.setattr(runner.BenchmarkResults, 'latest_suite_run', latest)
    monkeypatch.setattr(runner.BenchmarkResults, 'completed', completed)
    monkeypatch.setattr(runner.BenchmarkResults, 'windows_of', windows_of)


def _resume(monkeypatch, recorded: dict, asked: str | None):
    import asyncio

    from local_llm.benchmarks.evaluation import runner

    row = {'benchmark': 'livecodebench', 'item_id': 'atcoder/x', 'adapter': {}, 'item': {}}
    if asked:
        row['item_window'] = asked

    async def stop(*_a, **_k):
        raise RuntimeError('reached')

    _resume_patches(monkeypatch, row, recorded)
    monkeypatch.setattr(runner.BenchmarkSuiteExclusions, 'record_exclusions', stop)
    asyncio.run(runner.prepare_suite(None, suite_name='smoke', resume=True))


def test_resuming_under_another_window_is_refused(monkeypatch):
    from local_llm.benchmarks.evaluation.runner import SuiteLoadError

    with pytest.raises(
        SuiteLoadError, match=r'drew livecodebench from 2025-01-05\.\., and this run asks for 2025-02-01\.\.'
    ):
        _resume(monkeypatch, {'livecodebench': {'2025-01-05..'}}, '2025-02-01..')
    with pytest.raises(SuiteLoadError, match='asks for no window'):
        _resume(monkeypatch, {'livecodebench': {'2025-01-05..'}}, None)


def test_resuming_under_the_same_window_goes_ahead(monkeypatch):
    with pytest.raises(RuntimeError, match='reached'):
        _resume(monkeypatch, {'livecodebench': {'2025-01-05..'}}, '2025-01-05..')


def test_a_graded_item_records_its_window(monkeypatch):
    import asyncio

    from local_llm.benchmarks.evaluation import runner

    seen: dict = {}

    async def ask(*_a, **_k):
        ans = runner.Answer()
        ans.content = fenced('print(9)')
        return ans

    async def add_result(record, answer=None):
        seen.update(record)
        return 1

    monkeypatch.setattr(runner, 'ask', ask)
    monkeypatch.setattr(runner, 'grade', lambda adapter, item, content: ('pass', ''))
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    ctx = {
        'suite_run_id': 's',
        'run_id': None,
        'model': 'm',
        'config_id': None,
        'profile': {},
        'port': 0,
        'stream': False,
        'revisions': {'livecodebench': 'r'},
        'tier': 'smoke',
        'seed': 0,
        'params': {},
    }
    row = {
        'benchmark': 'livecodebench',
        'item_id': 'atcoder/x',
        'adapter': ADAPTER,
        'item': {**STDIN_ITEM, 'question_content': 'q', 'starter_code': '', 'contest_id': 'abc1'},
        'item_window': '2025-01-05..',
    }
    asyncio.run(runner.run_item(None, row, ctx))
    assert seen['item_window'] == '2025-01-05..' and seen['cluster'] == 'atcoder/abc1'


# --- review fixes ---------------------------------------------------------------------------------


def test_a_child_in_its_own_session_cannot_hold_the_grader(monkeypatch):
    # It outlives the process group kill and keeps the pipes open; the grade
    # must still end within the test's limit plus the bounded drain.
    code = (
        'import subprocess, sys, time\n'
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)\n"
        'time.sleep(30)\n'
    )
    started = time.monotonic()
    outcome, _ = _graded(monkeypatch, STDIN_ITEM, fenced(code), timeout_per_test=1)
    assert outcome == FAIL_TIMEOUT
    assert time.monotonic() - started < 15


def test_output_that_finished_counts_though_a_child_holds_the_pipe(monkeypatch):
    code = (
        'import subprocess, sys\n'
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)\n"
        'print(int(input()) ** 2)\n'
    )
    assert _graded(monkeypatch, STDIN_ITEM, fenced(code), timeout_per_test=1) == (PASS, '')


def test_a_functional_answer_cannot_read_its_tests():
    program = harness.build_program(
        FUNC_ITEM,
        "import json\ndef pairUp(nums, k):\n    return json.load(open('tests.json'))[0]['output']",
        ADAPTER['check'],
    )
    assert program is not None
    files = {'tests.json': json.dumps(FUNC_ITEM['public_test_cases']).encode()}
    outcome, reason = grading.run_program(program, 30, False, files=files)
    # Unlinked before the answer is loaded.
    assert outcome == FAIL_ERROR and 'FileNotFoundError' in reason


def test_the_window_ends_at_midnight_of_its_last_day_as_livecodebench_s_does():
    window = livecodebench_data.parse_window('2025-01-01', '2025-01-11')
    assert livecodebench_data.in_window({'d': '2025-01-11T00:00:00'}, 'd', window)
    assert not livecodebench_data.in_window({'d': '2025-01-11T18:30:00'}, 'd', window)
    assert livecodebench_data.in_window({'d': '2025-01-01T00:00:00'}, 'd', window)
    assert not livecodebench_data.in_window({'d': '2024-12-31T23:59:00'}, 'd', window)
    assert livecodebench_data.in_window({'d': '2026-01-01T07:30:00'}, 'd', (dt.date(2025, 1, 1), None))


def test_an_increment_repeating_a_problem_already_fetched_is_refused(lcb, tmp_path):
    dup = _increment_file(tmp_path, 'test2.jsonl', [_row('atcoder', 'abc100_a', '2024-05-01', [])])
    lcb['fetch']['increment'][1] = dup
    livecodebench_data.fetch(lcb, ['test.jsonl'])
    with pytest.raises(DatasetError, match='test2.jsonl and test.jsonl both hold atcoder/abc100_a'):
        livecodebench_data.fetch(lcb, ['test2.jsonl'])
    assert sorted(livecodebench_data.present(lcb)) == ['test.jsonl']


def test_a_row_missing_a_field_is_a_dataset_error():
    row = _row('atcoder', 'abc1', '2025-01-01', [])
    del row['metadata']
    with pytest.raises(DatasetError, match="no 'metadata' field"):
        livecodebench_data.decode_row(row, 'test6.jsonl')
    with pytest.raises(DatasetError, match="no 'output' field"):
        livecodebench_data.decode_private_tests(json.dumps([{'input': '1', 'testtype': 'stdin'}]))


def test_a_run_started_without_a_window_can_be_resumed_with_one(monkeypatch):
    with pytest.raises(RuntimeError, match='reached'):
        _resume(monkeypatch, {}, '2025-01-05..')


def test_resuming_a_windowed_run_for_another_benchmark_is_not_refused(monkeypatch):
    import asyncio

    from local_llm.benchmarks.evaluation import runner

    row = {'benchmark': 'mbppplus', 'item_id': 'Mbpp/2', 'adapter': {}, 'item': {}}

    async def stop(*_a, **_k):
        raise RuntimeError('reached')

    _resume_patches(monkeypatch, row, {'livecodebench': {'2025-01-05..'}})
    monkeypatch.setattr(runner.BenchmarkSuiteExclusions, 'record_exclusions', stop)
    with pytest.raises(RuntimeError, match='reached'):
        asyncio.run(runner.prepare_suite(None, suite_name='smoke', resume=True, benchmark='mbppplus'))
