"""Characterization tests for loading and calling tools in utils/tools.py.

get_tools, get_builtin_tools and execute_tool_server were refactored for
ruff's complexity limit with no tests of their own, so these pin what they
did before the refactor. For get_tools: which tools load, with what spec,
signature and metadata, every access check, cache use and valve read, and
what each tool's callable passes on when called. For get_builtin_tools:
which built-in tools a model, its features and the user's permissions get,
and the parameters bound into them. For execute_tool_server: the HTTP
request made for an operation and what comes back. Tools, access grants,
groups, config, permissions, tool servers and the HTTP session are fakes
that record their calls. Each case was recorded from the untouched
functions into fixtures/tool_loading.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`TOOL_LOADING_GOLDEN_RECORD=1 pytest tests/test_tool_loading.py`.
"""

import asyncio
import copy
import inspect
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm import env
from local_llm.utils import tools

GOLDEN = Path(__file__).parent / 'fixtures' / 'tool_loading.json'
RECORD = os.environ.get('TOOL_LOADING_GOLDEN_RECORD') == '1'


def _plain(value):
    """Turn what reached a fake (valves objects included) into JSON-comparable data."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, set):
        return sorted(_plain(v) for v in value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, '__dict__'):
        return {'type': type(value).__name__, **_plain(vars(value))}
    return repr(value)


# --- get_tools -------------------------------------------------------------


class _Valves:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _UserValves(_Valves):
    pass


async def _add(a: int, b: int, __id__=None, __user__=None, __metadata__=None):
    """Add two numbers.

    :param a: the first
    :return: the sum
    """
    return {'a': a, 'b': b, '__id__': __id__, '__user__': __user__, '__metadata__': __metadata__}


def _shout(text: str, __user__=None):
    return {'text': text.upper(), '__user__': __user__}


async def _blank_doc(n: int | None = None):
    """ """
    return {'n': n}


FUNCTIONS = {'add': _add, 'shout': _shout, 'blank_doc': _blank_doc}
CALL_ARGS = {'add': {'a': '2', 'b': 3}, 'shout': {'text': 5}, 'blank_doc': {'n': '7'}}


def _spec(name, properties, required=()):
    return {'name': name, 'parameters': {'type': 'object', 'properties': properties, 'required': list(required)}}


ADD_SPEC = _spec(
    'add',
    {'a': {'type': 'int'}, 'b': {'type': 'str'}, '__user__': {'type': 'object'}, '__id__': {'type': 'string'}},
    ['a', 'b'],
)
SHOUT_SPEC = _spec('shout', {'text': {'type': 'str'}}, ['text'])
BLANK_SPEC = _spec('blank_doc', {'n': {'type': 'integer'}})

TOOL_ROWS = {
    'calc': {'user_id': 'u1', 'content': 'v1', 'specs': [ADD_SPEC, BLANK_SPEC]},
    'loud': {'user_id': 'other', 'content': 'v1', 'specs': [SHOUT_SPEC]},
    'shared': {'user_id': 'other', 'content': 'v1', 'specs': [SHOUT_SPEC]},
}
MODULES = {
    'calc': {'valves': {'base': 10}, 'user_valves': {'tone': 'dry'}, 'file_handler': True, 'citation': False},
    'loud': {},
    'shared': {'citation': True},
}
SERVER_SPECS = [
    {'name': 'list_items', 'description': 'List', 'parameters': {'type': 'object', 'properties': {}}},
    {'name': 'delete_item', 'description': 'Delete', 'parameters': {'type': 'object', 'properties': {}}},
]
SERVERS = [
    {'id': 'inv', 'idx': 0, 'url': 'https://inv.test', 'openapi': {'paths': {}}, 'specs': SERVER_SPECS},
    {'id': 'far', 'idx': 5, 'url': 'https://far.test', 'specs': SERVER_SPECS},
    {'id': 'locked', 'idx': 1, 'url': 'https://locked.test', 'specs': SERVER_SPECS},
]
CONNECTIONS = [
    {'name': 'inventory', 'config': {'function_name_filter_list': 'list_items, !archived'}},
    {'name': 'locked', 'allow': False},
]

GET_TOOLS_CASES = [
    ('plugins_disabled', {'tool_ids': ['calc']}, {'plugins': False}),
    ('no_tool_ids', {'tool_ids': []}, {}),
    ('own_tool_with_valves', {'tool_ids': ['calc']}, {}),
    ('denied_tool', {'tool_ids': ['loud']}, {}),
    ('granted_tool', {'tool_ids': ['shared']}, {'grants': ['shared']}),
    ('admin_bypass', {'tool_ids': ['loud']}, {'admin': True, 'bypass': True}),
    ('admin_without_bypass', {'tool_ids': ['loud']}, {'admin': True}),
    ('cached_module_reused', {'tool_ids': ['calc']}, {'cache': {'calc': 'v1'}}),
    ('cached_module_stale', {'tool_ids': ['calc']}, {'cache': {'calc': 'v0'}}),
    ('name_collision', {'tool_ids': ['loud', 'shared']}, {'admin': True, 'bypass': True}),
    ('unknown_tool_id', {'tool_ids': ['ghost']}, {}),
    ('server_openapi', {'tool_ids': ['server:inv']}, {}),
    ('server_openapi_typed_and_suffixed', {'tool_ids': ['server:openapi:inv|abc']}, {}),
    ('server_mcp_skipped', {'tool_ids': ['server:mcp:inv']}, {}),
    ('server_not_found', {'tool_ids': ['server:nowhere']}, {}),
    ('server_index_out_of_range', {'tool_ids': ['server:far']}, {}),
    ('server_access_denied', {'tool_ids': ['server:locked']}, {}),
    (
        'server_filter_as_list',
        {'tool_ids': ['server:inv']},
        {'connections': [{'config': {'function_name_filter_list': ['!delete_item']}}]},
    ),
    ('server_no_filter', {'tool_ids': ['server:inv']}, {'connections': [{}]}),
    (
        'server_empty_filter_list',
        {'tool_ids': ['server:inv']},
        {'connections': [{'config': {'function_name_filter_list': []}}]},
    ),
    ('server_name_collision', {'tool_ids': ['server:inv', 'server:openapi:inv']}, {'connections': [{}]}),
    ('local_and_server', {'tool_ids': ['calc', 'server:inv']}, {}),
    ('server_id_with_extra_colons', {'tool_ids': ['calc', 'server:mcp:a:b']}, {}),
]


def _install_get_tools(m, world, log):
    tool_rows = {tid: SimpleNamespace(id=tid, **copy.deepcopy(row)) for tid, row in TOOL_ROWS.items()}
    tools_cache = {}
    contents_cache = {}
    for tool_id, content in world.get('cache', {}).items():
        tools_cache[tool_id] = _module(tool_id, log, cached=True)
        contents_cache[tool_id] = content

    async def get_groups_by_member_id(user_id):
        log.append(['groups', user_id])
        return [SimpleNamespace(id='g2'), SimpleNamespace(id='g1')]

    async def get_tools_by_ids(tool_ids):
        log.append(['tools_by_ids', tool_ids])
        return {tid: tool_rows[tid] for tid in tool_ids if tid in tool_rows}

    async def has_access(user_id, resource_type, resource_id, permission, user_group_ids=None):
        log.append(['has_access', user_id, resource_type, resource_id, permission, sorted(user_group_ids)])
        return resource_id in world.get('grants', [])

    async def load_tool_module_by_id(tool_id, content=None):
        log.append(['load_module', tool_id, content])
        return _module(tool_id, log), {}

    async def get_tool_valves_by_id(tool_id):
        log.append(['tool_valves', tool_id])
        return MODULES[tool_id].get('valves')

    async def get_user_valves_by_id_and_user_id(tool_id, user_id):
        log.append(['user_valves', tool_id, user_id])
        return MODULES[tool_id].get('user_valves', {})

    async def get_tool_servers(request):
        log.append(['tool_servers'])
        return copy.deepcopy(SERVERS)

    async def config_get(key, default=None):
        log.append(['config_get', key, default])
        return copy.deepcopy(world.get('connections', CONNECTIONS))

    async def has_connection_access(user, connection, user_group_ids=None):
        log.append(['connection_access', user.id, connection.get('name'), sorted(user_group_ids)])
        return connection.get('allow', True)

    async def build_tool_server_headers(connection, request, user, server_id='', metadata=None, extra_params=None):
        log.append(['server_headers', connection.get('name'), server_id, metadata, sorted(extra_params)])
        return {'Authorization': f'Bearer {server_id}'}, {'session': 'c1'}

    async def execute_tool_server(url, headers, cookies, name, params, server_data):
        log.append(['execute_tool_server', url, headers, cookies, name, params, server_data['id']])
        return {'ok': name}, None

    m.setattr(tools, 'ENABLE_PLUGINS', world.get('plugins', True))
    m.setattr(tools, 'BYPASS_ADMIN_ACCESS_CONTROL', world.get('bypass', False))
    m.setattr(tools.Groups, 'get_groups_by_member_id', get_groups_by_member_id)
    m.setattr(tools.Tools, 'get_tools_by_ids', get_tools_by_ids)
    m.setattr(tools.Tools, 'get_tool_valves_by_id', get_tool_valves_by_id)
    m.setattr(tools.Tools, 'get_user_valves_by_id_and_user_id', get_user_valves_by_id_and_user_id)
    m.setattr(tools.AccessGrants, 'has_access', has_access)
    m.setattr(tools, 'get_tools_cache', lambda request: tools_cache)
    m.setattr(tools, 'get_tool_contents_cache', lambda request: contents_cache)
    m.setattr(tools, 'load_tool_module_by_id', load_tool_module_by_id)
    m.setattr(tools, 'get_tool_servers', get_tool_servers)
    m.setattr(tools.Config, 'get', config_get)
    m.setattr(tools, 'has_connection_access', has_connection_access)
    m.setattr(tools, 'build_tool_server_headers', build_tool_server_headers)
    m.setattr(tools, 'execute_tool_server', execute_tool_server)
    return contents_cache


def _module(tool_id, log, cached=False):
    """A tool module whose functions report what they were called with."""
    traits = MODULES[tool_id]
    module = SimpleNamespace(name=f'{tool_id}{" (cached)" if cached else ""}')
    for spec in TOOL_ROWS[tool_id]['specs']:
        setattr(module, spec['name'], FUNCTIONS[spec['name']])
    if 'valves' in traits:
        module.Valves = _Valves
        module.valves = None
    if 'user_valves' in traits:
        module.UserValves = _UserValves
    for trait in ('file_handler', 'citation'):
        if trait in traits:
            setattr(module, trait, traits[trait])
    return module


def _describe_tool(name, entry):
    """A loaded tool as data: its spec and metadata, the signature it exposes, and what calling it does."""
    callable_ = entry['callable']
    spec = entry['spec']
    described = {
        'name': name,
        **{k: v for k, v in entry.items() if k != 'callable'},
        'signature': list(inspect.signature(callable_).parameters),
        'is_coroutine': inspect.iscoroutinefunction(callable_),
    }
    described['called_with'] = asyncio.run(callable_(**CALL_ARGS.get(spec['name'], {})))
    return _plain(described)


def _run_get_tools(kwargs, world, m):
    log = []
    contents_cache = _install_get_tools(m, world, log)
    user = SimpleNamespace(id='u1', role='admin' if world.get('admin') else 'user')
    extra_params = {
        '__user__': {'id': 'u1', 'name': 'Ada'},
        '__metadata__': {'chat_id': 'c1'},
        '__event_emitter__': '<emitter>',
    }
    request = SimpleNamespace(name='<request>')
    try:
        returned = asyncio.run(tools.get_tools(request, copy.deepcopy(kwargs['tool_ids']), user, extra_params))
    except Exception as e:
        return {'raised': [type(e).__name__, str(e)], 'calls': log}
    loaded = [_describe_tool(name, entry) for name, entry in returned.items()]
    return {'tools': loaded, 'contents_cache': dict(contents_cache), 'calls': log}


# --- get_builtin_tools -----------------------------------------------------

ALL_ON = {
    'web.search.enable': True,
    'image_generation.enable': True,
    'images.edit.enable': True,
    'code_interpreter.enable': True,
    'notes.enable': True,
    'channels.enable': True,
    'automations.enable': True,
    'calendar.enable': True,
    'ui.enable_user_webhooks': True,
    'subagents.enable': True,
    'subagents.background_enabled': True,
}
ALL_FEATURES = {'memory': True, 'web_search': True, 'image_generation': True, 'code_interpreter': True}
SAVED_CHAT = '7f1c0d9e-3b5a-4c1e-9a2f-0b8d6e4c2a10'
CHAT_FILE = {'type': 'file', 'id': 'file-1', 'name': 'data.csv'}


def _model(meta):
    return {'id': 'm', 'info': {'meta': meta}}


BUILTIN_CASES = [
    ('defaults_user_nothing_enabled', {}, {'config': {}}),
    ('admin_everything_enabled', {'features': ALL_FEATURES, 'chat_id': SAVED_CHAT}, {'admin': True, 'config': ALL_ON}),
    (
        'user_permissions_mixed',
        {'features': ALL_FEATURES, 'chat_id': SAVED_CHAT},
        {
            'config': ALL_ON,
            'permitted': ['features.web_search', 'features.notes', 'features.calendar', 'features.memories'],
        },
    ),
    (
        'categories_switched_off',
        {
            'features': ALL_FEATURES,
            'model': _model(
                {
                    'builtinTools': {
                        'time': False,
                        'user_input': False,
                        'knowledge': False,
                        'chats': False,
                        'subagents': False,
                        'memory': False,
                        'web_search': False,
                        'image_generation': False,
                        'code_interpreter': False,
                        'notes': False,
                        'channels': False,
                        'tasks': False,
                        'automations': False,
                        'calendar': False,
                        'notifications': False,
                    }
                }
            ),
            'chat_id': SAVED_CHAT,
        },
        {'admin': True, 'config': ALL_ON},
    ),
    (
        'capabilities_switched_off',
        {
            'features': ALL_FEATURES,
            'model': _model(
                {
                    'capabilities': {
                        'memory': False,
                        'web_search': False,
                        'image_generation': False,
                        'code_interpreter': False,
                    }
                }
            ),
        },
        {'admin': True, 'config': ALL_ON},
    ),
    (
        'chat_files_without_file_context',
        {
            'model': _model({'capabilities': {'file_upload': True, 'file_context': False}}),
            'files': [CHAT_FILE, {'type': 'file', 'url': 'https://x.test/a.png'}, 'junk'],
        },
        {'permitted': ['chat.file_upload']},
    ),
    (
        'chat_files_from_extra_params',
        {'model': _model({'capabilities': {'file_context': False}}), 'extra_files': [CHAT_FILE]},
        {'admin': True},
    ),
    (
        'chat_files_only_remote',
        {'model': _model({'capabilities': {'file_context': False}}), 'files': [{'id': 'data:image/png;base64,AA'}]},
        {'admin': True},
    ),
    (
        'chat_files_no_permission',
        {'model': _model({'capabilities': {'file_context': False}}), 'files': [CHAT_FILE]},
        {},
    ),
    (
        'model_knowledge_files_and_notes',
        {
            'model': _model(
                {'knowledge': [{'type': 'file', 'id': 'f1'}, {'type': 'note', 'id': 'n1'}, {'type': 'note'}]}
            )
        },
        {},
    ),
    ('model_knowledge_note_only', {'model': _model({'knowledge': [{'type': 'note', 'id': 'n1'}]})}, {}),
    ('model_knowledge_collection_only', {'model': _model({'knowledge': [{'type': 'collection', 'id': 'kb1'}]})}, {}),
    (
        'folder_and_chat_knowledge',
        {
            'model': _model({'capabilities': {'file_context': False}}),
            'folder_knowledge': [{'type': 'collection', 'id': 'kb1'}, 'junk'],
            'files': [
                {'type': 'collection', 'id': 'kb1'},
                {'type': 'note', 'id': 'n2', 'name': 'N'},
                {'type': 'file', 'id': 'x'},
            ],
        },
        {},
    ),
    ('kb_exec_without_model_knowledge', {}, {'kb_exec': True}),
    (
        'kb_exec_with_note_knowledge',
        {'model': _model({'knowledge': [{'type': 'note', 'id': 'n1'}]})},
        {'kb_exec': True},
    ),
    (
        'kb_exec_with_file_knowledge',
        {'model': _model({'knowledge': [{'type': 'file', 'id': 'f1'}]})},
        {'kb_exec': True},
    ),
    ('internal_request', {'features': ALL_FEATURES}, {'admin': True, 'config': ALL_ON, 'internal': True}),
    ('direct_request', {'features': ALL_FEATURES}, {'admin': True, 'config': ALL_ON, 'direct': True}),
    (
        'subagents_without_background',
        {},
        {'admin': True, 'config': {'subagents.enable': True, 'subagents.background_enabled': False}},
    ),
    ('note_chat_with_notes_off', {'is_note_chat': True}, {}),
    ('skills_attached', {'skill_ids': ['s1']}, {}),
    ('local_chat_has_no_tasks', {'chat_id': 'local:abc'}, {'admin': True}),
]


def _run_builtin(kwargs, world, m):
    log = []
    config = world.get('config', {})

    async def get_many(*keys):
        log.append(['config_get_many', list(keys)])
        return {key: config[key] for key in keys if key in config}

    async def config_get(key, default=None):
        log.append(['config_get', key])
        return {'chat': {'file_upload': False}}

    async def has_permission(user_id, permission_key, default_permissions=None):
        log.append(['has_permission', user_id, permission_key])
        return permission_key in world.get('permitted', [])

    m.setattr(tools.Config, 'get_many', get_many)
    m.setattr(tools.Config, 'get', config_get)
    m.setattr(tools, 'has_permission', has_permission)
    m.setattr(env, 'ENABLE_KB_EXEC', world.get('kb_exec', False))

    request = SimpleNamespace(
        state=SimpleNamespace(**{k: True for k in ('internal', 'direct') if world.get(k)}), name='<request>'
    )
    metadata = {'chat_id': kwargs.get('chat_id'), 'folder_knowledge': kwargs.get('folder_knowledge')}
    if 'files' in kwargs:
        metadata['files'] = kwargs['files']
    extra_params = {
        '__user__': {'id': 'u1', 'role': 'admin' if world.get('admin') else 'user'},
        '__metadata__': metadata,
        '__event_emitter__': '<emitter>',
        '__event_call__': '<call>',
        '__chat_id__': kwargs.get('chat_id'),
        '__message_id__': 'msg-1',
        **({'__files__': kwargs['extra_files']} if 'extra_files' in kwargs else {}),
        **({'__skill_ids__': kwargs['skill_ids']} if 'skill_ids' in kwargs else {}),
    }
    returned = asyncio.run(
        tools.get_builtin_tools(
            request,
            extra_params,
            features=kwargs.get('features'),
            model=kwargs.get('model'),
            is_note_chat=kwargs.get('is_note_chat', False),
        )
    )

    bound = {}
    loaded = []
    for name, entry in returned.items():
        extra = entry['callable'].__extra_params__
        for key, value in extra.items():
            bound[key] = '<request>' if value is request else _plain(value)
        loaded.append([name, entry['tool_id'], entry['type'], sorted(extra)])
    delegate = returned.get('delegate_task', {}).get('spec', {}).get('parameters', {})
    return {
        'tools': loaded,
        'bound': bound,
        'delegate_background': {
            'property': 'background' in delegate.get('properties', {}),
            'required': 'background' in (delegate.get('required') or []),
        },
        'calls': log,
    }


# --- execute_tool_server ---------------------------------------------------

ITEM_PATHS = {
    '/items/{item_id}': {
        'summary': 'not an operation',
        'parameters': [
            {'name': 'item_id', 'in': 'path', 'required': True},
            {'name': 'verbose', 'in': 'query'},
            'junk',
            {'in': 'query'},
        ],
        'get': {
            'operationId': 'get_item',
            'parameters': [
                {'name': 'verbose', 'in': 'query', 'required': True},
                {'name': 'fields', 'in': 'query'},
                {'name': 'tag', 'in': 'query'},
                {'name': 'unused', 'in': 'query'},
            ],
        },
        'put': {
            'operationId': 'update_item',
            'parameters': 'not a list',
            'requestBody': {'content': {'application/json': {'schema': {'type': 'object'}}}},
        },
        'delete': {'operationId': 'delete_item'},
        'head': {'operationId': 'head_item'},
    },
    '/items': {
        'options': 'not an operation',
        'parameters': 'not a list',
        'post': {
            'operationId': 'create_item',
            'parameters': [{'name': 'dry_run', 'in': 'query'}, 'junk', {'in': 'query'}],
            'requestBody': {'content': {'application/json': {'schema': {'type': 'object'}}}},
        },
        'patch': {'operationId': 'touch_items', 'requestBody': {}},
        'x-internal': {'operationId': 'secret'},
    },
    '/broken': 'not a path item',
}
SERVER_DATA = {'id': 'inv', 'openapi': {'paths': ITEM_PATHS}}
JSON_OK = {'status': 200, 'json': {'ok': True}, 'headers': {'Content-Type': 'application/json', 'X-Trace': 't1'}}

EXECUTE_CASES = [
    ('no_openapi', {'name': 'get_item', 'server_data': {'id': 'empty'}}, {}),
    ('unknown_operation', {'name': 'secret'}, {}),
    (
        'get_with_path_and_query',
        {'name': 'get_item', 'params': {'item_id': 'a b/c', 'verbose': '', 'fields': '', 'tag': None, 'extra': 1}},
        {'response': JSON_OK},
    ),
    (
        'get_query_values',
        {'name': 'get_item', 'params': {'item_id': 7, 'verbose': True, 'fields': 'name', 'tag': ['x', 'y']}},
        {'response': JSON_OK},
    ),
    (
        'put_body_with_path_param',
        {'name': 'update_item', 'params': {'item_id': 7, 'name': 'new'}, 'url': 'https://inv.test/'},
        {'response': JSON_OK},
    ),
    ('post_body_and_query', {'name': 'create_item', 'params': {'dry_run': 'yes', 'name': 'n'}}, {'response': JSON_OK}),
    ('post_without_params', {'name': 'create_item', 'params': {}}, {'response': JSON_OK}),
    ('patch_without_body_schema', {'name': 'touch_items', 'params': {'all': True}}, {'response': JSON_OK}),
    ('delete_sends_empty_json', {'name': 'delete_item', 'params': {'item_id': 3}}, {'response': JSON_OK}),
    ('head_like_get', {'name': 'head_item', 'params': {'item_id': 3}}, {'response': JSON_OK}),
    (
        'get_http_error',
        {'name': 'get_item', 'params': {'item_id': 1}},
        {'response': {'status': 404, 'text': 'no such item'}},
    ),
    (
        'post_http_error',
        {'name': 'create_item', 'params': {}},
        {'response': {'status': 500, 'text': 'boom'}},
    ),
    (
        'text_reply',
        {'name': 'get_item', 'params': {'item_id': 1}},
        {
            'response': {
                'status': 200,
                'json': 'raise',
                'text': 'plain words',
                'headers': {'Content-Type': 'text/plain; charset=utf-8'},
            }
        },
    ),
    (
        'untyped_reply',
        {'name': 'create_item', 'params': {}},
        {'response': {'status': 200, 'json': 'raise', 'text': 'mystery', 'headers': {}}},
    ),
    (
        'binary_reply',
        {'name': 'get_item', 'params': {'item_id': 1}},
        {'response': {'status': 200, 'json': 'raise', 'body': 'PNGDATA', 'headers': {'Content-Type': 'image/png'}}},
    ),
    (
        'binary_reply_to_post',
        {'name': 'create_item', 'params': {}},
        {'response': {'status': 200, 'json': 'raise', 'body': 'PDF', 'headers': {'Content-Type': 'application/pdf'}}},
    ),
    (
        'text_reply_to_post',
        {'name': 'create_item', 'params': {}},
        {'response': {'status': 200, 'json': 'raise', 'text': 'created', 'headers': {'Content-Type': 'text/html'}}},
    ),
    ('connection_fails', {'name': 'get_item', 'params': {'item_id': 1}}, {'response': 'raise'}),
]


class _ToolResponse:
    def __init__(self, spec):
        self.spec = spec
        self.status = spec['status']
        self.headers = spec.get('headers', {})

    async def json(self):
        if self.spec.get('json') == 'raise':
            raise ValueError('not json')
        return copy.deepcopy(self.spec.get('json'))

    async def text(self):
        return self.spec.get('text', '')

    async def read(self):
        return self.spec.get('body', '').encode()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _ToolSession:
    def __init__(self, world, log, trust_env=False, timeout=None):
        self.world, self.log = world, log
        log.append(['client_session', trust_env, timeout.total if timeout else None])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __getattr__(self, method):
        def request(url, **kwargs):
            ssl = kwargs.pop('ssl', None) is tools.AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL
            redirects = kwargs.pop('allow_redirects', None) is tools.AIOHTTP_CLIENT_ALLOW_REDIRECTS
            self.log.append(['request', method, url, _plain(kwargs), {'ssl': ssl, 'allow_redirects': redirects}])
            if self.world['response'] == 'raise':
                raise OSError('connection refused')
            return _ToolResponse(self.world['response'])

        return request


def _run_execute(kwargs, world, m):
    log = []
    m.setattr(tools.aiohttp, 'ClientSession', lambda **kw: _ToolSession(world, log, **kw))
    returned = asyncio.run(
        tools.execute_tool_server(
            url=kwargs.get('url', 'https://inv.test'),
            headers={'Authorization': 'Bearer t'},
            cookies={'session': 'c1'},
            name=kwargs['name'],
            params=copy.deepcopy(kwargs.get('params', {})),
            server_data=copy.deepcopy(kwargs.get('server_data', SERVER_DATA)),
        )
    )
    data, headers = returned
    return {'returned': [_plain(data), _plain(headers)], 'calls': log}


# --- harness ---------------------------------------------------------------

RUNNERS = {'get_tools': _run_get_tools, 'builtin': _run_builtin, 'execute': _run_execute}
CASES = (
    [(f'get_tools:{c}', 'get_tools', k, w) for c, k, w in GET_TOOLS_CASES]
    + [(f'builtin:{c}', 'builtin', k, w) for c, k, w in BUILTIN_CASES]
    + [(f'execute:{c}', 'execute', k, w) for c, k, w in EXECUTE_CASES]
)


def _run(kind, kwargs, world, monkeypatch):
    return json.loads(json.dumps(RUNNERS[kind](kwargs, world, monkeypatch)))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'kind', 'kwargs', 'world'), CASES, ids=[c[0] for c in CASES])
def test_tool_loading_matches_golden(monkeypatch, case_id, kind, kwargs, world):
    observed = _run(kind, kwargs, world, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when TOOL_LOADING_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set TOOL_LOADING_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, kind, kwargs, world in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(kind, kwargs, world, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
