"""Each filter sees its own user valves, never another filter's (#173).

Filters run one after another with the same extra params. Setting a filter's
user valves wrote `valves` into the shared `__user__` dict, so a later filter
without UserValves of its own received the earlier filter's, and the
caller's `__user__` kept them after the request.

Run from apps/server:

    python -m pytest tests/test_filter_user_valves.py
"""

import asyncio
from types import SimpleNamespace

from pydantic import BaseModel

from local_llm.utils import filter as filter_utils


class _ValvesA(BaseModel):
    token: str = ''


def _filter_a(seen):
    class Module:
        UserValves = _ValvesA

        def inlet(self, body, __user__):
            seen['a'] = __user__.get('valves')
            return body

    return Module()


def _filter_b(seen):
    class Module:
        def inlet(self, body, __user__):
            seen['b'] = __user__.get('valves')
            return body

    return Module()


class FakeContext:
    async def get_user_valves(self, filter_id, user_id, user_valves_class):
        return user_valves_class(token=f'{filter_id}-{user_id}')


def test_a_filter_without_user_valves_does_not_see_another_filters(monkeypatch):
    seen = {}
    modules = {'a': _filter_a(seen), 'b': _filter_b(seen)}

    async def get_function_module(request, filter_id, load_from_db=True, function=None):
        return modules[filter_id]

    monkeypatch.setattr(filter_utils, 'ENABLE_PLUGINS', True)
    monkeypatch.setattr(filter_utils, 'get_function_module', get_function_module)
    user = {'id': 'u1', 'name': 'Ada'}

    asyncio.run(
        filter_utils.process_filter_functions(
            None,
            FakeContext(),
            [SimpleNamespace(id='a'), SimpleNamespace(id='b')],
            'inlet',
            {'messages': []},
            {'__user__': user},
        )
    )

    assert seen['a'] == _ValvesA(token='a-u1')
    assert seen['b'] is None
    # The caller's user is left as it was.
    assert user == {'id': 'u1', 'name': 'Ada'}
