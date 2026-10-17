"""Characterization tests for process_chat_payload in utils/middleware.py.

process_chat_payload, which turns a chat request into the payload sent to
the model, was refactored for ruff's complexity limit with no tests of its
own, so these pin what it did before the refactor: the form data, metadata
and events it returns (or what it raises), and every call it makes, in
order. Its pure helpers (message shaping, params, skill parsing, knowledge
listing) run for real. Everything that reaches out (chats, folders, notes,
skills, filters, the pipeline inlet, memory, web search, image generation,
MCP servers, tools, terminals, file context, compaction, system prompt
templating, permissions, config, event emitters) is a fake that records
its calls. Each case was recorded from the untouched function into
fixtures/chat_payload.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`CHAT_PAYLOAD_GOLDEN_RECORD=1 pytest tests/test_chat_payload.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models import skills
from local_llm.models.users import UserModel
from local_llm.utils import middleware

GOLDEN = Path(__file__).parent / 'fixtures' / 'chat_payload.json'
RECORD = os.environ.get('CHAT_PAYLOAD_GOLDEN_RECORD') == '1'

SAVED_CHAT = '7f1c0d9e-3b5a-4c1e-9a2f-0b8d6e4c2a10'
NATIVE = {'function_calling': 'native'}
LEGACY = {'function_calling': 'legacy'}

MODEL = {'id': 'm1', 'info': {'meta': {}}}
MODELS = {
    'm1': MODEL,
    'm2': {'id': 'm2', 'info': {'meta': {}}},
    'arena': {'id': 'arena', 'owned_by': 'arena'},
    'task-model': {'id': 'task-model'},
}


def _messages(*pairs):
    return [{'role': role, 'content': content} for role, content in pairs]


CHAT = _messages(('system', 'Be brief.'), ('user', 'What is 2+2?'))


def _case(name, form=None, metadata=None, world=None, model=None):
    return (name, form or {}, metadata or {}, world or {}, model)


CASES_SPEC = [
    # --- basics and arena
    _case('minimal', {'messages': _messages(('user', 'hi'))}, {'chat_id': None}),
    _case('chat_id_not_string', {'messages': _messages(('user', 'hi'))}, {'chat_id': 42}),
    _case(
        'arena_listed_models',
        {'messages': CHAT},
        world={},
        model={'id': 'arena', 'owned_by': 'arena', 'info': {'meta': {'model_ids': ['m2', 'm1']}}},
    ),
    _case(
        'arena_exclude_mode',
        {'messages': CHAT},
        model={'id': 'arena', 'owned_by': 'arena', 'info': {'meta': {'model_ids': ['m1'], 'filter_mode': 'exclude'}}},
    ),
    _case('arena_any_model', {'messages': CHAT}, model={'id': 'arena', 'owned_by': 'arena', 'info': {}}),
    _case(
        'arena_pick_unknown',
        {'messages': CHAT},
        model={'id': 'arena', 'owned_by': 'arena', 'info': {'meta': {'model_ids': ['ghost']}}},
    ),
    _case('params_applied', {'messages': CHAT, 'params': {'temperature': 0.3, 'system': 'Model prompt'}}),
    # --- history from the database
    _case(
        'db_history_with_images_and_continue',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1', 'assistant_message_id': 'a1'},
        {
            'db_messages': [
                {
                    'role': 'user',
                    'content': 'Look',
                    'files': [
                        {'type': 'image', 'url': 'u.png'},
                        {'content_type': 'image/jpeg', 'url': 'v.jpg'},
                        {'type': 'image'},
                        {'type': 'file', 'id': 'f'},
                    ],
                },
                {
                    'role': 'user',
                    'content': [{'type': 'text', 'text': 'list'}],
                    'files': [{'type': 'image', 'url': 'w.png'}],
                },
            ],
            'assistant_message': {
                'id': 'a1',
                'role': 'assistant',
                'content': 'partial',
                'output': [],
                'done': False,
                'extra': 1,
            },
        },
    ),
    _case(
        'db_history_without_system',
        {'messages': _messages(('user', 'x'))},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1', 'assistant_message_id': 'a1'},
        {
            'db_messages': [{'role': 'user', 'content': 'from db'}],
            'assistant_message': {'id': 'a1', 'role': 'assistant', 'content': ''},
        },
    ),
    _case(
        'db_history_empty', {'messages': CHAT}, {'chat_id': SAVED_CHAT, 'user_message_id': 'u1'}, {'db_messages': None}
    ),
    _case(
        'db_history_not_continuing',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1'},
        {'db_messages': [{'role': 'user', 'content': 'stored'}]},
    ),
    _case(
        'db_history_continue_empty_message',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1', 'assistant_message_id': 'a1'},
        {'db_messages': [{'role': 'user', 'content': 'stored'}], 'assistant_message': None},
    ),
    _case('regeneration_prompt', {'messages': CHAT, 'regeneration_prompt': 'Shorter please'}),
    _case(
        'compaction_summary',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1'},
        {'compaction': 'Earlier we talked.'},
    ),
    _case(
        'compaction_direct_model',
        {'messages': _messages(('user', 'q'))},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1'},
        {'direct': True},
    ),
    _case(
        'compaction_fails',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT, 'user_message_id': 'u1'},
        {'compaction': 'raise'},
    ),
    _case(
        'other_models_reasoning_stripped',
        {
            'messages': [
                {'role': 'user', 'content': 'q'},
                {
                    'role': 'assistant',
                    'model': 'm2',
                    'content': 'a',
                    'output': [{'type': 'reasoning', 'id': 'r', 'reasoning_details': [1]}],
                },
                {
                    'role': 'assistant',
                    'model': 'm1',
                    'content': 'b',
                    'output': [{'type': 'reasoning', 'id': 's', 'reasoning_details': [2]}],
                },
                {'role': 'user', 'content': 'again'},
            ]
        },
    ),
    _case('system_prompt_templating_fails', {'messages': CHAT}, world={'system_prompt_raise': True}),
    # --- folders
    _case(
        'folder_prompt_and_files_legacy',
        {'messages': CHAT, 'files': [{'type': 'file', 'id': 'f1'}]},
        {'chat_id': SAVED_CHAT, 'params': LEGACY},
        {'chat_folder': 'fold-1', 'folders': {'fold-1': {'system_prompt': 'Folder rules', 'files': [{'id': 'ff'}]}}},
    ),
    _case(
        'folder_files_native',
        {'messages': CHAT},
        {'folder_id': 'fold-1', 'params': NATIVE},
        {'folders': {'fold-1': {'files': [{'id': 'ff'}]}}},
    ),
    _case(
        'folder_not_readable',
        {'messages': CHAT},
        {'folder_id': 'fold-1'},
        {'folders': {'fold-1': {'system_prompt': 'x'}}, 'folder_denied': True},
    ),
    _case(
        'folder_admin_reads_any',
        {'messages': CHAT},
        {'folder_id': 'fold-1'},
        {'admin': True, 'folders': {'fold-1': {'system_prompt': 'x'}}, 'folder_denied': True},
    ),
    _case('folder_without_data', {'messages': CHAT}, {'folder_id': 'fold-1'}, {'folders': {'fold-1': None}}),
    _case('folder_missing', {'messages': CHAT}, {'folder_id': 'fold-gone'}),
    # --- model knowledge (legacy)
    _case(
        'model_knowledge_legacy',
        {'messages': CHAT, 'files': [{'id': 'f0'}]},
        {'params': LEGACY},
        model={
            'id': 'm1',
            'info': {
                'meta': {
                    'knowledge': [
                        {'collection_name': 'col-a', 'name': 'A'},
                        {'collection_names': ['col-b', 'col-c'], 'name': 'BC'},
                        {'type': 'file', 'id': 'f9'},
                    ]
                }
            },
        },
    ),
    _case(
        'model_knowledge_native',
        {'messages': CHAT},
        {'params': NATIVE},
        model={'id': 'm1', 'info': {'meta': {'knowledge': [{'type': 'file', 'id': 'f9'}]}}},
    ),
    # --- inlet stages
    _case('pipeline_inlet_fails', {'messages': CHAT}, world={'inlet_raise': True}),
    _case('plugins_disabled', {'messages': CHAT}, world={'plugins': False}),
    _case('filter_inlet_fails', {'messages': CHAT}, world={'filter_raise': 'inlet'}),
    _case(
        'filter_inlet_adds_tools',
        {'messages': CHAT},
        {'params': NATIVE, 'session_id': 's'},
        {'inlet_tools': [{'type': 'function', 'function': {'name': 'filter_tool'}}], 'builtin_tools': ['get_time']},
    ),
    # --- features
    _case(
        'voice_prompt',
        {'messages': CHAT, 'features': {'voice': True}},
        world={'config': {'task.voice.prompt.enable': True, 'task.voice.prompt_template': 'Speak plainly.'}},
    ),
    _case(
        'voice_default_template',
        {'messages': CHAT, 'features': {'voice': True}},
        world={'config': {'task.voice.prompt.enable': True}},
    ),
    _case('voice_disabled', {'messages': CHAT, 'features': {'voice': True}}),
    _case(
        'memory_permitted',
        {'messages': CHAT, 'features': {'memory': True}},
        world={'config': {'memories.system_context.enable': True}, 'permitted': ['features.memories']},
    ),
    _case(
        'memory_not_permitted',
        {'messages': CHAT, 'features': {'memory': True}},
        world={'config': {'memories.system_context.enable': True}},
    ),
    _case(
        'memory_admin',
        {'messages': CHAT, 'features': {'memory': True}},
        world={'admin': True, 'config': {'memories.system_context.enable': True}},
    ),
    _case('memory_context_off', {'messages': CHAT, 'features': {'memory': True}}),
    _case(
        'web_search_legacy',
        {'messages': CHAT, 'features': {'web_search': True}},
        {'params': LEGACY},
        {'config': {'web.search.enable': True}, 'permitted': ['features.web_search']},
    ),
    _case(
        'web_search_native',
        {'messages': CHAT, 'features': {'web_search': True}},
        {'params': NATIVE},
        {'admin': True, 'config': {'web.search.enable': True}},
    ),
    _case(
        'web_search_not_permitted',
        {'messages': CHAT, 'features': {'web_search': True}},
        {'params': LEGACY},
        {'config': {'web.search.enable': True}},
    ),
    _case('web_search_off', {'messages': CHAT, 'features': {'web_search': True}}, {'params': LEGACY}),
    _case(
        'image_generation_legacy',
        {'messages': CHAT, 'features': {'image_generation': True}},
        {'params': LEGACY},
        {'permitted': ['features.image_generation']},
    ),
    _case(
        'image_generation_native',
        {'messages': CHAT, 'features': {'image_generation': True}},
        {'params': NATIVE},
        {'admin': True},
    ),
    _case(
        'image_generation_not_permitted', {'messages': CHAT, 'features': {'image_generation': True}}, {'params': LEGACY}
    ),
    _case(
        'code_interpreter_legacy_pyodide',
        {'messages': CHAT, 'features': {'code_interpreter': True}},
        {'params': LEGACY},
    ),
    _case(
        'code_interpreter_legacy_jupyter_custom',
        {'messages': CHAT, 'features': {'code_interpreter': True}},
        {'params': LEGACY},
        {'config': {'code_interpreter.engine': 'jupyter', 'code_interpreter.prompt_template': 'Use the kernel.'}},
    ),
    _case(
        'code_interpreter_native_pyodide',
        {'messages': CHAT, 'features': {'code_interpreter': True}},
        {'params': NATIVE},
    ),
    _case(
        'code_interpreter_native_jupyter',
        {'messages': CHAT, 'features': {'code_interpreter': True}},
        {'params': NATIVE},
        {'config': {'code_interpreter.engine': 'jupyter'}},
    ),
    _case(
        'features_all_false',
        {
            'messages': CHAT,
            'features': {
                'voice': False,
                'memory': False,
                'web_search': False,
                'image_generation': False,
                'code_interpreter': False,
            },
        },
    ),
    # --- skills
    _case(
        'skills_native_manifest_and_mention',
        {
            'messages': _messages(('system', 'S'), ('user', 'Use <$sk-mention|Mention> please')),
            'skill_ids': ['sk-sel', 'sk-off'],
        },
        {'session_id': 's', 'params': NATIVE},
        {
            'skills': ['sk-sel', 'sk-off', 'sk-mention', 'sk-model'],
            'inactive_skills': ['sk-off'],
            'builtin_tools': ['view_skill'],
        },
        {'id': 'm1', 'info': {'meta': {'skillIds': ['sk-model']}}},
    ),
    _case(
        'skills_legacy_full_content',
        {'messages': CHAT, 'skill_ids': ['sk-sel']},
        {'params': LEGACY},
        {'skills': ['sk-sel']},
    ),
    _case(
        'skill_only_prompt_falls_back',
        {'messages': _messages(('user', '<$sk-mention|Mention>')), 'skill_ids': []},
        {'params': LEGACY},
        {'skills': ['sk-mention']},
    ),
    _case('skills_not_accessible', {'messages': CHAT, 'skill_ids': ['sk-hidden']}),
    _case(
        'skill_mention_without_label',
        {'messages': _messages(('user', '<$sk-mention>'))},
        {'params': LEGACY},
        {'skills': ['sk-mention']},
    ),
    _case('empty_prompt_without_skills', {'messages': _messages(('user', '   '))}),
    # --- note chats
    _case(
        'note_chat_files',
        {'messages': CHAT, 'files': [{'id': 'f1'}]},
        {'chat_id': SAVED_CHAT},
        {
            'chat': {'internal': True, 'type': 'note', 'note_id': 'n1'},
            'note_owner': 'u1',
            'builtin_tools': ['view_note'],
        },
    ),
    _case(
        'note_chat_shared_note',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT},
        {'chat': {'internal': True, 'type': 'note', 'note_id': 'n1'}, 'note_owner': 'x', 'note_grant': True},
    ),
    _case(
        'note_chat_note_denied',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT},
        {'chat': {'internal': True, 'type': 'note', 'note_id': 'n1'}, 'note_owner': 'x'},
    ),
    _case(
        'note_chat_admin',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT},
        {
            'admin': True,
            'chat': {'internal': True, 'type': 'note', 'note_id': 'n1'},
            'note_owner': 'x',
            'note_files': [],
        },
    ),
    _case(
        'note_chat_without_note_id',
        {'messages': CHAT},
        {'chat_id': SAVED_CHAT},
        {'chat': {'internal': True, 'type': 'note'}},
    ),
    _case('saved_chat_not_note', {'messages': CHAT}, {'chat_id': SAVED_CHAT}, {'chat': {'type': 'note'}}),
    # --- tools
    _case(
        'tools_mcp_db_terminal_direct_builtin',
        {
            'messages': CHAT,
            'tool_ids': ['server:mcp:docs', 'server:mcp:empty', 'server:mcp:broken', 'calc'],
            'terminal_id': 'term-1',
            'files': [{'id': 'f1'}, {'id': 'f1'}, {'id': 'f2'}],
        },
        {
            'session_id': 's',
            'params': NATIVE,
            'tool_servers': [
                {'url': 'https://direct.test', 'system_prompt': 'Direct rules', 'specs': [{'name': 'direct_op'}]},
                {'url': 'https://bare.test'},
            ],
        },
        {
            'mcp': {'docs': ['search', 'fetch'], 'empty': None, 'broken': 'raise'},
            'db_tools': ['calc_add'],
            'terminal': 'tuple',
            'builtin_tools': ['calc_add', 'get_time'],
        },
        {
            'id': 'm1',
            'info': {
                'meta': {
                    'knowledge': [
                        {'type': 'file', 'id': 'k1', 'name': 'Spec <v2>'},
                        {'type': 'note'},
                        {'type': 'collection', 'id': 'kb2'},
                    ]
                }
            },
        },
    ),
    _case(
        'tools_mcp_fails_without_emitter',
        {'messages': CHAT, 'tool_ids': ['server:mcp:broken']},
        {'params': NATIVE},
        {'mcp': {'broken': 'raise'}, 'no_emitter': True},
    ),
    _case(
        'tools_db_only_plugins_off', {'messages': CHAT, 'tool_ids': ['calc']}, {'params': NATIVE}, {'plugins': False}
    ),
    _case('terminal_dict_result', {'messages': CHAT, 'terminal_id': 't'}, {'params': NATIVE}, {'terminal': 'dict'}),
    _case('terminal_empty', {'messages': CHAT, 'terminal_id': 't'}, {'params': NATIVE}, {'terminal': 'empty'}),
    _case('terminal_fails', {'messages': CHAT, 'terminal_id': 't'}, {'params': NATIVE}, {'terminal': 'raise'}),
    _case(
        'terminal_capability_off',
        {'messages': CHAT, 'terminal_id': 't'},
        {'params': NATIVE},
        {'terminal': 'dict'},
        {'id': 'm1', 'info': {'meta': {'capabilities': {'terminal': False}}}},
    ),
    _case(
        'legacy_tools_handler',
        {'messages': CHAT, 'tool_ids': ['calc']},
        {'params': LEGACY},
        {'db_tools': ['calc_add'], 'tools_handler_sources': [{'source': {'name': 'calc'}}]},
    ),
    _case(
        'legacy_tools_handler_fails',
        {'messages': CHAT, 'tool_ids': ['calc']},
        {'params': LEGACY},
        {'db_tools': ['calc_add'], 'tools_handler_raise': True},
    ),
    _case(
        'payload_tools_given',
        {'messages': CHAT, 'tools': [{'type': 'function', 'function': {'name': 'mine'}}], 'tool_ids': ['calc']},
        {'session_id': 's', 'params': NATIVE},
    ),
    _case(
        'builtin_tools_capability_off',
        {'messages': CHAT},
        {'session_id': 's', 'params': NATIVE},
        {'builtin_tools': ['x']},
        {'id': 'm1', 'info': {'meta': {'capabilities': {'builtin_tools': False}}}},
    ),
    _case(
        'builtin_knowledge_tags_off',
        {'messages': CHAT},
        {'session_id': 's', 'params': NATIVE},
        {'builtin_tools': []},
        {
            'id': 'm1',
            'info': {'meta': {'builtinTools': {'knowledge': False}, 'knowledge': [{'type': 'file', 'id': 'k1'}]}},
        },
    ),
    _case('no_tools_at_all', {'messages': CHAT}, {'session_id': 's', 'params': NATIVE}, {'builtin_tools': []}),
    # --- files and sources
    _case(
        'file_sources_and_context',
        {'messages': CHAT, 'files': [{'id': 'f1'}]},
        {},
        {
            'files_sources': [{'source': {'name': 'doc.pdf'}}, {'source': {'id': 'x'}}, {'source': {}}, {}],
            'model_system_prompt': 'Resolved model prompt',
        },
    ),
    _case(
        'file_sources_without_prompt',
        {'messages': _messages(('user', ''))},
        {},
        {'files_sources': [{'source': {'name': 'n'}}]},
    ),
    _case('files_handler_fails', {'messages': CHAT}, {}, {'files_raise': True}),
    _case(
        'file_context_off',
        {'messages': CHAT},
        {},
        {},
        {'id': 'm1', 'info': {'meta': {'capabilities': {'file_context': False}}}},
    ),
    _case(
        'model_prompt_without_system_message',
        {'messages': _messages(('user', 'q'))},
        {},
        {'model_system_prompt': 'Only the model prompt'},
    ),
    _case('request_filter_fails', {'messages': CHAT}, {}, {'filter_raise': 'request'}),
]

CASES = [(f'payload:{c[0]}', *c[1:]) for c in CASES_SPEC]


def _plain(value):
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, set):
        return sorted(_plain(v) for v in value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, _MCPClient):
        return f'<mcp client {value.server_id}>'
    if isinstance(value, UserModel):
        return f'<user {value.id}>'
    if callable(value):
        return f'<callable {getattr(value, "__name__", "?")}>'
    if hasattr(value, 'model_dump'):
        return _plain(value.model_dump())
    return repr(value)


class _MCPClient:
    def __init__(self, server_id, log):
        self.server_id, self.log = server_id, log

    async def call_tool(self, function_name, function_args=None):
        self.log.append(['mcp.call_tool', self.server_id, function_name, function_args])
        return [{'type': 'text', 'text': f'{function_name} ran'}]


def _skill(skill_id, active=True):
    return SimpleNamespace(
        id=skill_id,
        name=skill_id.upper(),
        content=f'{skill_id} instructions',
        description=f'about {skill_id}',
        is_active=active,
    )


def _recorder(log):
    """fake(name, result) builds an async fake that logs its call and returns result (or result(*args))."""

    def fake(name, result=None, raise_on=None):
        async def call(*args, **kwargs):
            log.append([name, _plain(args), _plain({k: v for k, v in kwargs.items() if k != 'extra_params'})])
            if raise_on and raise_on(args, kwargs):
                raise RuntimeError(f'{name} failed')
            return result(*args, **kwargs) if callable(result) else copy.deepcopy(result)

        return call

    return fake


def _pass_form(*args, **kwargs):
    return args[1] if len(args) > 1 else kwargs.get('form_data')


def _install_reads(m, world, log, fake):
    """Config, chats, folders, notes and skills."""
    # Unset keys read as the app's own defaults where code depends on them.
    config = {
        'task.model.default': '',
        'task.model.external': '',
        'code_interpreter.prompt_template': '',
        **world.get('config', {}),
    }

    async def config_get(key, default=None):
        log.append(['config_get', key])
        return copy.deepcopy(config.get(key, default))

    def folder(folder_id):
        folders = world.get('folders', {})
        if folder_id not in folders:
            return None
        return SimpleNamespace(id=folder_id, data=copy.deepcopy(folders[folder_id]))

    def chat_by_id(chat_id):
        return SimpleNamespace(meta=copy.deepcopy(world['chat'])) if 'chat' in world else None

    def note_by_id(note_id):
        files = world.get(
            'note_files', [{'id': 'nf1'}, {'type': 'image', 'id': 'img'}, {'content_type': 'image/png'}, 'junk']
        )
        return SimpleNamespace(id=note_id, user_id=world.get('note_owner'), data={'files': copy.deepcopy(files)})

    def get_skills(user_id=None, ids=None):
        known = world.get('skills', [])
        return [_skill(s, s not in world.get('inactive_skills', [])) for s in ids if s in known]

    m.setattr(middleware.Config, 'get', config_get)
    m.setattr(
        middleware.Chats, 'get_message_by_id_and_message_id', fake('chats.get_message', world.get('assistant_message'))
    )
    m.setattr(middleware.Chats, 'get_chat_folder_id', fake('chats.get_chat_folder_id', world.get('chat_folder')))
    m.setattr(middleware.Chats, 'get_chat_by_id', fake('chats.get_chat_by_id', chat_by_id))
    m.setattr(middleware.Folders, 'get_folder_by_id', fake('folders.get_folder_by_id', folder))
    m.setattr(middleware.Notes, 'get_note_by_id', fake('notes.get_note_by_id', note_by_id))
    m.setattr(
        middleware.AccessGrants,
        'has_access',
        fake('access_grants.has_access', lambda *a, **k: bool(world.get('note_grant'))),
    )
    m.setattr(skills.Skills, 'get_skills', fake('skills.get_skills', get_skills))
    m.setattr(middleware, 'load_messages_from_db', fake('load_messages_from_db', world.get('db_messages')))
    m.setattr(
        middleware, 'has_folder_access', fake('has_folder_access', lambda *a, **k: not world.get('folder_denied'))
    )
    m.setattr(
        middleware,
        'get_owner_accessible_folder_files',
        fake('get_owner_accessible_folder_files', [{'id': 'owner-file'}]),
    )


def _install_stages(m, world, log, fake):
    """Prompt shaping, the event emitter, the inlet pipeline and filters, and the feature handlers."""

    def apply_system_prompt(system, form_data, metadata=None, user=None, replace=False):
        if world.get('system_prompt_raise') and replace:
            raise RuntimeError('bad template')
        return {
            **form_data,
            'messages': [*form_data['messages'], {'role': 'system', 'content': f'[templated {system}]'}],
        }

    def compaction(request, user, messages, metadata, model_id, models, system_prompt):
        if world.get('compaction') == 'raise':
            raise RuntimeError('compaction model down')
        return messages[-2:], world.get('compaction'), None

    def filter_functions(
        request=None, filter_context=None, filter_functions=None, filter_type=None, form_data=None, extra_params=None
    ):
        if world.get('filter_raise') == filter_type:
            raise HTTPException(status_code=403, detail=f'{filter_type} filter blocked')
        form_data = {**form_data, f'{filter_type}_filtered': True}
        if filter_type == 'inlet' and world.get('inlet_tools'):
            form_data['tools'] = copy.deepcopy(world['inlet_tools'])
        return form_data, {}

    async def emitter(event):
        log.append(['emit', _plain(event)])

    async def get_event_emitter(metadata):
        log.append(['get_event_emitter', metadata.get('message_id')])
        return None if world.get('no_emitter') else emitter

    async def get_event_call(metadata):
        return '<event_call>'

    patches = {
        'compact_messages_for_request': fake('compact_messages_for_request', compaction),
        'apply_system_prompt_to_body': fake('apply_system_prompt_to_body', apply_system_prompt),
        'convert_url_images_to_base64': fake('convert_url_images_to_base64', lambda form_data, user=None: form_data),
        'get_event_emitter': get_event_emitter,
        'get_event_call': get_event_call,
        'get_system_oauth_token': fake('get_system_oauth_token', {'access_token': 'sys'}),
        'process_pipeline_inlet_filter': fake(
            'process_pipeline_inlet_filter', _pass_form, lambda a, k: world.get('inlet_raise')
        ),
        'get_filter_context': lambda request: '<filter_context>',
        'get_filter_functions': fake('get_filter_functions', ['<filter>']),
        'process_filter_functions': fake('process_filter_functions', filter_functions),
        'add_memory_context': fake('add_memory_context', _pass_form),
        'chat_web_search_handler': fake('chat_web_search_handler', _pass_form),
        'chat_image_generation_handler': fake('chat_image_generation_handler', _pass_form),
        'has_permission': fake('has_permission', lambda user_id, key, default=None: key in world.get('permitted', [])),
        'resolve_system_prompt': fake(
            'resolve_system_prompt', lambda prompt, metadata, user: world.get('model_system_prompt') or prompt
        ),
        'ENABLE_PLUGINS': world.get('plugins', True),
        'random': SimpleNamespace(choice=lambda options: options[0]),
    }
    for name, value in patches.items():
        m.setattr(middleware, name, value)


def _install_tools(m, world, log, fake):
    """MCP servers, tools, terminals, builtin tools, and the tool and file handlers."""

    def connect_mcp(request, server_id, user, metadata, extra_params):
        behaviour = world.get('mcp', {}).get(server_id)
        if behaviour == 'raise':
            raise RuntimeError('mcp refused')
        if behaviour is None:
            return None
        return _MCPClient(server_id, log), [{'name': n, 'parameters': {}} for n in behaviour]

    def tools_for(request, tool_ids, user, extra_params):
        return {
            name: {'spec': {'name': name}, 'callable': len, 'tool_id': 'calc'} for name in world.get('db_tools', [])
        }

    def terminal(request, terminal_id, user, extra_params):
        kind = world.get('terminal')
        if kind == 'raise':
            raise RuntimeError('terminal offline')
        tools = {'run': {'spec': {'name': 'run'}, 'type': 'terminal'}}
        if kind == 'tuple':
            return tools, 'Terminal is at /work'
        return {} if kind == 'empty' else tools

    def builtin(request, extra_params, features, model, is_note_chat=False):
        return {name: {'spec': {'name': name}, 'type': 'builtin'} for name in world.get('builtin_tools', [])}

    def tools_handler(request, form_data, extra_params, user, models, tools_dict):
        if world.get('tools_handler_raise'):
            raise RuntimeError('tool selection failed')
        return {**form_data, 'tools_handled': sorted(tools_dict)}, {
            'sources': copy.deepcopy(world.get('tools_handler_sources', []))
        }

    def files_handler(request, form_data, extra_params, user):
        if world.get('files_raise'):
            raise RuntimeError('retrieval failed')
        return form_data, {'sources': copy.deepcopy(world.get('files_sources', []))}

    def source_context(request, messages, sources, prompt):
        return [*messages, {'role': 'system', 'content': f'[context for {prompt}: {len(sources)} sources]'}]

    patches = {
        'connect_mcp_server': fake('connect_mcp_server', connect_mcp),
        'get_tools': fake('get_tools', tools_for),
        'get_terminal_tools': fake('get_terminal_tools', terminal),
        'add_file_context': fake(
            'add_file_context', lambda messages, chat_id, user: [*messages, {'role': 'system', 'content': '[files]'}]
        ),
        'get_builtin_tools': fake('get_builtin_tools', builtin),
        'chat_completion_tools_handler': fake('chat_completion_tools_handler', tools_handler),
        'chat_completion_files_handler': fake('chat_completion_files_handler', files_handler),
        'apply_source_context_to_messages': fake('apply_source_context_to_messages', source_context),
    }
    for name, value in patches.items():
        m.setattr(middleware, name, value)


def _install(m, world, log):
    fake = _recorder(log)
    _install_reads(m, world, log, fake)
    _install_stages(m, world, log, fake)
    _install_tools(m, world, log, fake)


def _run(form, metadata, world, model, monkeypatch):
    log = []
    _install(monkeypatch, world, log)
    user = UserModel(
        id='u1',
        email='ada@example.com',
        name='Ada',
        role='admin' if world.get('admin') else 'user',
        last_active_at=1,
        updated_at=1,
        created_at=1,
    )
    state = SimpleNamespace(**({'direct': True, 'model': {'id': 'direct-model'}} if world.get('direct') else {}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(MODELS=copy.deepcopy(MODELS))), state=state)
    metadata = {'message_id': 'a1', **copy.deepcopy(metadata)}
    try:
        form_data, returned_metadata, events = asyncio.run(
            middleware.process_chat_payload(
                request,
                {'model': (model or MODEL)['id'], **copy.deepcopy(form)},
                user,
                metadata,
                copy.deepcopy(model or MODEL),
            )
        )
        outcome = {'form_data': _plain(form_data), 'metadata': _plain(returned_metadata), 'events': _plain(events)}
        # Each MCP tool's callable must reach its own tool on its own server.
        for name, tool in (returned_metadata.get('tools') or {}).items():
            if tool.get('type') == 'mcp':
                log.append(['called', name, asyncio.run(tool['callable'](query='q'))])
    except HTTPException as e:
        outcome = {'http_error': [e.status_code, e.detail]}
    except Exception as e:
        outcome = {'raised': [type(e).__name__, str(e)]}
    return json.loads(json.dumps({**outcome, 'metadata_given_after': _plain(metadata), 'calls': log}))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'form', 'metadata', 'world', 'model'), CASES, ids=[c[0] for c in CASES])
def test_chat_payload_matches_golden(monkeypatch, case_id, form, metadata, world, model):
    observed = _run(form, metadata, world, model, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when CHAT_PAYLOAD_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set CHAT_PAYLOAD_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, form, metadata, world, model in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(form, metadata, world, model, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
