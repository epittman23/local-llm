"""Characterization tests for Users.get_users (models/users.py).

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: the exact SQL it runs (the
count and the page query, compiled for PostgreSQL with values inlined)
for each combination of filter, sort and pagination, and what it
returns. The session is a fake that records statements, so no database is
needed. Each case was recorded from the untouched method into
fixtures/get_users_query.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`GET_USERS_GOLDEN_RECORD=1 pytest tests/test_get_users_query.py`.
"""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from sqlalchemy.dialects import postgresql

from local_llm.models import users as users_model

GOLDEN = Path(__file__).parent / 'fixtures' / 'get_users_query.json'
RECORD = os.environ.get('GET_USERS_GOLDEN_RECORD') == '1'

SORT_FIELDS = ['name', 'email', 'created_at', 'last_active_at', 'updated_at', 'role']

# (case id, kwargs for get_users)
CASES = [
    ('defaults', {}),
    ('empty_filter_and_sort', {'filter': {}, 'sort': {}}),
    ('query', {'filter': {'query': "ada o'brien"}}),
    ('empty_query', {'filter': {'query': ''}}),
    ('channel', {'filter': {'channel_id': 'ch1'}}),
    ('user_ids', {'filter': {'user_ids': ['u1', 'u2']}}),
    ('group_ids', {'filter': {'group_ids': ['g1']}}),
    ('user_and_group_ids', {'filter': {'user_ids': ['u1'], 'group_ids': ['g1', 'g2']}}),
    ('both_id_lists_empty_returns_nothing', {'filter': {'user_ids': [], 'group_ids': []}}),
    ('one_id_list_empty', {'filter': {'user_ids': [], 'group_ids': ['g1']}}),
    ('empty_user_ids_alone', {'filter': {'user_ids': []}}),
    ('id_filters_not_lists', {'filter': {'user_ids': ('u1',), 'group_ids': ()}}),
    ('roles_include', {'filter': {'roles': ['admin', 'user']}}),
    ('roles_exclude', {'filter': {'roles': ['!pending']}}),
    ('roles_mixed', {'filter': {'roles': ['user', '!pending', '!admin']}}),
    ('roles_empty', {'filter': {'roles': []}}),
    (
        'every_filter',
        {
            'filter': {
                'query': 'x',
                'channel_id': 'ch1',
                'user_ids': ['u1'],
                'group_ids': ['g1'],
                'roles': ['user', '!pending'],
            }
        },
    ),
    *[(f'sort_{field}_asc', {'sort': {'order_by': field, 'direction': 'asc'}}) for field in SORT_FIELDS],
    *[(f'sort_{field}_desc', {'sort': {'order_by': field, 'direction': 'desc'}}) for field in SORT_FIELDS],
    *[(f'sort_{field}_default_direction', {'sort': {'order_by': field}}) for field in SORT_FIELDS],
    ('sort_group_asc', {'sort': {'order_by': 'group_id:g1', 'direction': 'asc'}}),
    ('sort_group_desc', {'sort': {'order_by': 'group_id:g1', 'direction': 'desc'}}),
    ('sort_group_with_colon_in_id', {'sort': {'order_by': 'group_id:a:b'}}),
    ('sort_unknown_without_filter', {'sort': {'order_by': 'favorite_color', 'direction': 'asc'}}),
    ('sort_unknown_with_filter', {'filter': {'roles': ['user']}, 'sort': {'order_by': 'favorite_color'}}),
    ('no_sort_with_filter', {'filter': {'query': 'x'}}),
    ('sort_with_filter', {'filter': {'query': 'x'}, 'sort': {'order_by': 'email', 'direction': 'asc'}}),
    ('sort_direction_only', {'sort': {'direction': 'asc'}}),
    ('skip_and_limit', {'skip': 20, 'limit': 10}),
    ('zero_skip_and_limit', {'skip': 0, 'limit': 0}),
    ('limit_only', {'limit': 5}),
    (
        'everything',
        {
            'filter': {'query': 'x', 'group_ids': ['g1'], 'roles': ['!pending']},
            'sort': {'order_by': 'group_id:g1', 'direction': 'asc'},
            'skip': 5,
            'limit': 5,
        },
    ),
]


class _FakeResult:
    def scalar(self):
        return 7

    def scalars(self):
        return self

    def all(self):
        return []


class _FakeSession:
    def __init__(self, executed: list):
        self.executed = executed

    async def execute(self, stmt):
        self.executed.append(str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={'literal_binds': True})))
        return _FakeResult()


def _run(kwargs: dict, monkeypatch) -> dict:
    executed = []

    @asynccontextmanager
    async def fake_db_context(db=None):
        yield _FakeSession(executed)

    monkeypatch.setattr(users_model, 'get_async_db_context', fake_db_context)
    result = asyncio.run(users_model.Users.get_users(**kwargs))
    return {'executed': executed, 'result': result}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'kwargs'), CASES, ids=[c[0] for c in CASES])
def test_get_users_matches_golden(monkeypatch, case_id, kwargs):
    observed = _run(kwargs, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when GET_USERS_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set GET_USERS_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, kwargs in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(kwargs, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
