"""The sandbox tools' registration (T12): their specs, their names, and which engine offers which tools.

`get_builtin_tools` is run for real, with only its inputs faked (global config, the user's permissions, the model's
capabilities); the tests pin that:

- each of bash, view, write_file and str_replace has a spec the real generator builds from its docstring, with
  the dunder parameters left out;
- no built-in tool shares a name with another, and each spec is named after its function;
- the sandbox engine offers the four, any other engine (a stored 'jupyter' included) offers no code tool, and
  `execute_code` is offered under no engine, and each of the four gates (config switch, model capability, chat
  feature, user permission) still blocks
  under the sandbox engine.

Run from apps/server:

    python -m pytest tests/test_sandbox_tools_registration.py
"""

import asyncio
import inspect
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from local_llm.tools import builtin
from local_llm.utils import tools

SANDBOX_TOOLS = ['bash', 'view', 'write_file', 'str_replace']
ALL_CODE_TOOLS = {*SANDBOX_TOOLS, 'execute_code'}
FEATURES = {'code_interpreter': True}
PERMITTED = ['features.code_interpreter']


def _request() -> Any:
    return SimpleNamespace(state=SimpleNamespace())


def _offered(
    monkeypatch: pytest.MonkeyPatch,
    *,
    engine: object = 'sandbox',
    enable: object = True,
    features: dict | None = None,
    meta: dict | None = None,
    permitted: list[str] | None = None,
    role: str = 'user',
) -> set[str]:
    """The names of the code tools get_builtin_tools offers under these inputs."""
    config: dict = {'code_interpreter.enable': enable}
    if engine is not None:
        config['code_interpreter.engine'] = engine

    async def get_many(*keys):
        return {key: config[key] for key in keys if key in config}

    async def config_get(key, default=None):
        return {}

    async def has_permission(user_id, permission_key, default_permissions=None):
        return permission_key in (PERMITTED if permitted is None else permitted)

    monkeypatch.setattr(tools.Config, 'get_many', get_many)
    monkeypatch.setattr(tools.Config, 'get', config_get)
    monkeypatch.setattr(tools, 'has_permission', has_permission)
    request = _request()
    extra = {'__user__': {'id': 'u1', 'role': role}, '__metadata__': {'chat_id': 'local:x'}}
    model = {'id': 'm', 'info': {'meta': meta or {}}}
    returned = asyncio.run(
        tools.get_builtin_tools(request, extra, features=FEATURES if features is None else features, model=model)
    )
    return set(returned) & ALL_CODE_TOOLS


# Specs.


@pytest.mark.parametrize('func', [builtin.bash, builtin.view, builtin.write_file, builtin.str_replace])
def test_each_sandbox_tool_has_a_generated_spec_named_after_its_function(func):
    spec = tools.get_builtin_tool_spec(func)
    assert spec['name'] == func.__name__
    assert spec['description'].strip()
    assert spec['parameters']['type'] == 'object'


@pytest.mark.parametrize('func', [builtin.bash, builtin.view, builtin.write_file, builtin.str_replace])
def test_spec_parameters_are_the_models_and_never_the_dunder_ones(func):
    spec = tools.get_builtin_tool_spec(func)
    declared = {
        name
        for name in inspect.signature(func).parameters
        if not name.startswith('__')  # the injected parameters
    }
    assert set(spec['parameters']['properties']) == declared
    assert all(prop['description'].strip() for prop in spec['parameters']['properties'].values())


@pytest.mark.parametrize(
    ('func', 'required'),
    [
        (builtin.bash, ['command']),
        (builtin.view, ['path']),
        (builtin.write_file, ['path', 'content']),
        (builtin.str_replace, ['path', 'old_str', 'new_str']),
    ],
)
def test_spec_requires_exactly_the_arguments_without_a_default(func, required):
    assert tools.get_builtin_tool_spec(func)['parameters']['required'] == required


def test_bash_spec_types_and_defaults_its_arguments():
    properties = tools.get_builtin_tool_spec(builtin.bash)['parameters']['properties']
    assert properties['timeout_s']['type'] == 'integer'
    # No default in the spec: left out, the command gets the admin's setting (configured_timeout).
    assert 'default' not in properties['timeout_s']
    assert "server's setting" in properties['timeout_s']['description']
    assert properties['image']['type'] == 'string'


def test_bash_spec_describes_what_each_image_contains():
    image = tools.get_builtin_tool_spec(builtin.bash)['parameters']['properties']['image']['description']
    assert "'data'" in image
    assert "'web'" in image
    for contents in ('Python', 'numpy', 'pandas', 'R with', 'TeX Live', 'Node.js', 'Playwright'):
        assert contents in image


def test_write_file_spec_defaults_overwrite_to_false():
    properties = tools.get_builtin_tool_spec(builtin.write_file)['parameters']['properties']
    assert properties['overwrite']['type'] == 'boolean'
    assert properties['overwrite']['default'] is False


def test_view_spec_says_hidden_entries_are_left_out_except_runs():
    assert '.runs' in tools.get_builtin_tool_spec(builtin.view)['description']


# Names.


def _builtin_functions() -> list:
    # Every coroutine function the registry imports from tools/builtin.py, the candidates for a tool.
    return [
        func
        for func in vars(tools).values()
        if inspect.iscoroutinefunction(func) and getattr(func, '__module__', None) == builtin.__name__
    ]


def test_every_builtin_tool_spec_is_named_after_its_function_and_no_two_share_a_name():
    functions = _builtin_functions()
    assert {builtin.bash, builtin.view, builtin.write_file, builtin.str_replace} <= set(functions)
    names = [func.__name__ for func in functions]
    assert len(names) == len(set(names))
    spec_names = [tools.get_builtin_tool_spec(func)['name'] for func in functions]
    assert spec_names == names


def test_the_registry_imports_the_same_four_functions_the_builtin_module_defines():
    assert (tools.bash, tools.view, tools.write_file, tools.str_replace) == (
        builtin.bash,
        builtin.view,
        builtin.write_file,
        builtin.str_replace,
    )


@pytest.fixture
def everything_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[tools._BuiltinToolContext]:
    config = {
        key: True
        for key in (
            'web.search.enable',
            'image_generation.enable',
            'images.edit.enable',
            'code_interpreter.enable',
            'notes.enable',
            'channels.enable',
            'automations.enable',
            'calendar.enable',
            'ui.enable_user_webhooks',
            'subagents.enable',
            'subagents.background_enabled',
        )
    }

    async def has_permission(user_id, permission_key, default_permissions=None):
        return True

    async def config_get(key, default=None):
        return {}

    monkeypatch.setattr(tools, 'has_permission', has_permission)
    monkeypatch.setattr(tools.Config, 'get', config_get)
    extra = {
        '__user__': {'id': 'u1', 'role': 'admin'},
        '__metadata__': {
            'chat_id': '7f1c0d9e-3b5a-4c1e-9a2f-0b8d6e4c2a10',
            'files': [{'type': 'file', 'id': 'file-1', 'name': 'data.csv'}],
        },
        '__skill_ids__': ['s1'],
    }
    features = {'memory': True, 'web_search': True, 'image_generation': True, 'code_interpreter': True}
    yield tools._BuiltinToolContext(_request(), extra, features, {'id': 'm', 'info': {'meta': {}}}, False, config)


@pytest.mark.parametrize('engine', ['sandbox', 'jupyter'])
def test_no_selector_offers_a_name_another_selector_offers(everything_on, engine):
    everything_on.config['code_interpreter.engine'] = engine
    names = [func.__name__ for select in tools._BUILTIN_TOOL_SELECTORS for func in asyncio.run(select(everything_on))]
    assert len(names) == len(set(names))
    assert set(names) & ALL_CODE_TOOLS == ({*SANDBOX_TOOLS} if engine == 'sandbox' else set())


# Which engine offers which tools.


def test_the_sandbox_engine_offers_the_four_tools_and_not_execute_code(monkeypatch):
    assert _offered(monkeypatch, engine='sandbox') == set(SANDBOX_TOOLS)


def test_the_builtin_module_has_no_execute_code_tool():
    assert not hasattr(builtin, 'execute_code')


def test_the_four_tools_are_offered_in_the_order_the_model_is_to_see_them(monkeypatch):
    async def go():
        async def get_many(*keys):
            return {'code_interpreter.enable': True, 'code_interpreter.engine': 'sandbox'}

        async def has_permission(*args, **kwargs):
            return True

        async def config_get(key, default=None):
            return {}

        monkeypatch.setattr(tools.Config, 'get_many', get_many)
        monkeypatch.setattr(tools.Config, 'get', config_get)
        monkeypatch.setattr(tools, 'has_permission', has_permission)
        model = {'id': 'm', 'info': {'meta': {}}}
        extra = {'__user__': {'id': 'u1', 'role': 'user'}, '__metadata__': {}}
        return await tools.get_builtin_tools(_request(), extra, FEATURES, model)

    names = [name for name in asyncio.run(go()) if name in ALL_CODE_TOOLS]
    assert names == SANDBOX_TOOLS


@pytest.mark.parametrize('engine', ['jupyter', 'pyodide', None, '', 'SANDBOX', 'sandbox ', 'other'])
def test_any_other_engine_offers_no_code_tool(monkeypatch, engine):
    assert _offered(monkeypatch, engine=engine) == set()


def test_the_engine_is_read_in_the_same_config_batch_as_the_other_keys(monkeypatch):
    asked: list[tuple] = []

    async def get_many(*keys):
        asked.append(keys)
        return {}

    async def config_get(key, default=None):
        return {}

    monkeypatch.setattr(tools.Config, 'get_many', get_many)
    monkeypatch.setattr(tools.Config, 'get', config_get)
    extra = {'__user__': {'id': 'u1', 'role': 'user'}, '__metadata__': {}}
    asyncio.run(tools.get_builtin_tools(_request(), extra, {}, {}))
    assert len(asked) == 1
    assert 'code_interpreter.engine' in asked[0]
    assert 'code_interpreter.enable' in asked[0]


@pytest.mark.parametrize(
    ('gate', 'blocked'),
    [
        ('config', {'enable': False}),
        ('config unset', {'enable': None}),
        ('capability', {'meta': {'capabilities': {'code_interpreter': False}}}),
        ('feature off', {'features': {'code_interpreter': False}}),
        ('feature missing', {'features': {}}),
        ('permission', {'permitted': []}),
        ('permission of another feature', {'permitted': ['features.web_search']}),
        ('category switched off', {'meta': {'builtinTools': {'code_interpreter': False}}}),
    ],
)
def test_each_gate_blocks_every_tool_on_the_sandbox_engine(monkeypatch, gate, blocked):
    # The engine is the sandbox, so only the gate under test can be what empties the list.
    assert _offered(monkeypatch, engine='sandbox', **blocked) == set(), gate


def test_an_admin_passes_the_permission_gate_without_the_grant(monkeypatch):
    offered = _offered(monkeypatch, engine='sandbox', permitted=[], role='admin')
    assert offered == set(SANDBOX_TOOLS)


def test_the_capability_defaults_on_when_the_model_does_not_name_it(monkeypatch):
    offered = _offered(monkeypatch, meta={'capabilities': {'vision': True}})
    assert offered == set(SANDBOX_TOOLS)
