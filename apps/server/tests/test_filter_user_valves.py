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

import pytest
from pydantic import BaseModel

from local_llm.utils import filter as filter_utils


class _ValvesA(BaseModel):
    token: str = ''


def _module(filter_type, seen, name, user_valves=None):
    """A filter module whose `filter_type` handler records the valves it is given.

    It takes `body` (or a stream filter's `event`) by keyword, as the filter
    pipeline passes it.
    """

    def handler(self, __user__, **payload):
        seen[name] = __user__.get('valves')
        return payload.get('event', payload.get('body'))

    attrs = {filter_type: handler}
    if user_valves:
        attrs['UserValves'] = user_valves
    return type(f'Filter{name.upper()}', (), attrs)()


class FakeContext:
    async def get_user_valves(self, filter_id, user_id, user_valves_class):
        return user_valves_class(token=f'{filter_id}-{user_id}')


@pytest.mark.parametrize('filter_type', ['inlet', 'outlet', 'stream'])
@pytest.mark.parametrize('with_context', [True, False])
def test_a_filter_without_user_valves_does_not_see_another_filters(monkeypatch, filter_type, with_context):
    seen = {}
    modules = {'a': _module(filter_type, seen, 'a', _ValvesA), 'b': _module(filter_type, seen, 'b')}

    async def get_function_module(request, filter_id, load_from_db=True, function=None):
        return modules[filter_id]

    async def get_user_valves(filter_id, user_id, user_valves_class):
        return user_valves_class(token=f'{filter_id}-{user_id}')

    monkeypatch.setattr(filter_utils, 'ENABLE_PLUGINS', True)
    monkeypatch.setattr(filter_utils, 'get_function_module', get_function_module)
    # Outlet callers pass no filter context, so the valves come from the database.
    monkeypatch.setattr(filter_utils, 'get_user_valves', get_user_valves)
    user = {'id': 'u1', 'name': 'Ada'}

    asyncio.run(
        filter_utils.process_filter_functions(
            None,
            FakeContext() if with_context else None,
            [SimpleNamespace(id='a'), SimpleNamespace(id='b')],
            filter_type,
            {'messages': []},
            {'__user__': user},
        )
    )

    assert seen['a'] == _ValvesA(token='a-u1')
    assert seen['b'] is None
    # The caller's user is left as it was.
    assert user == {'id': 'u1', 'name': 'Ada'}
