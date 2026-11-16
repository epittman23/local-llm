"""GET /tasks/config/defaults returns the built-in task prompts (#1101).

Admin > Settings lets an admin override each background task's prompt
(title, follow-ups, tags, ...), but an empty box means "use the built-in",
and the built-in text could not be read, so an override had to be written
blind. This read-only, admin-only route returns the prompts the tasks fall
back to, keyed like GET /tasks/config, so the tab can show each one and
start an override from it.

Each value must be the very constant the runtime falls back to, or the tab
would show a default that is not the one in use.

A minimal app mounts only the tasks router; the signed-in user is faked one
level below the role checks, so the real admin check runs.

Run from apps/server:

    python -m pytest tests/test_task_prompt_defaults.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm import config
from local_llm.routers import tasks as tasks_router
from local_llm.utils import middleware
from local_llm.utils.auth import get_current_user


def _client(role: str) -> TestClient:
    app = FastAPI()
    app.include_router(tasks_router.router, prefix='/tasks')
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id='u1', role=role)
    return TestClient(app)


def test_an_admin_gets_every_task_prompt_keyed_like_the_config():
    res = _client('admin').get('/tasks/config/defaults')

    assert res.status_code == 200
    body = res.json()
    prompt_keys = {k for k in tasks_router.TASK_CONFIG_KEYS if k.endswith('PROMPT_TEMPLATE')}
    assert set(body) == prompt_keys
    assert all(isinstance(v, str) and v.strip() for v in body.values())


@pytest.mark.parametrize(
    ('field', 'fallback'),
    [
        # routers/tasks.py falls back to these when the stored template is empty.
        ('TITLE_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE),
        ('FOLLOW_UP_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_FOLLOW_UP_GENERATION_PROMPT_TEMPLATE),
        ('TAGS_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_TAGS_GENERATION_PROMPT_TEMPLATE),
        ('IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE),
        ('QUERY_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_QUERY_GENERATION_PROMPT_TEMPLATE),
        ('AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE', tasks_router.DEFAULT_AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE),
        # utils/middleware.py falls back to these two.
        ('TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE', middleware.DEFAULT_TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE),
        ('VOICE_MODE_PROMPT_TEMPLATE', middleware.DEFAULT_VOICE_MODE_PROMPT_TEMPLATE),
    ],
)
def test_each_default_is_the_prompt_the_runtime_falls_back_to(field, fallback):
    assert _client('admin').get('/tasks/config/defaults').json()[field] == fallback


def test_a_fresh_install_stores_empty_templates_so_the_defaults_apply():
    # The tab's Reset puts '' back, which only means "the built-in" if '' is what a fresh install stores.
    for field, key in tasks_router.TASK_CONFIG_KEYS.items():
        if field.endswith('PROMPT_TEMPLATE'):
            assert config.DEFAULT_CONFIG[key] == ''


@pytest.mark.parametrize('role', ['user', 'pending'])
def test_anyone_but_an_admin_is_refused(role):
    assert _client(role).get('/tasks/config/defaults').status_code == 401
