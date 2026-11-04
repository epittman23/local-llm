"""The workspace models' tag filter matches a model's tags, not any text in its meta (#280).

`search_models` filtered by tag with `LIKE '%"<tag>"%'` over the whole
serialized meta. So `vision` matched every model with the `vision`
capability, a word in a description or a knowledge file's name matched too,
and `%` and `_` in a tag were wildcards. The filter now looks only at the
names in `meta.tags`, case-insensitively as before.

The same script runs on the test run's SQLite database and, with
TEST_DATABASE_URL (CI provides one), on a fresh Postgres, since the match is
written in each one's JSON functions.

Run from apps/server:

    python -m pytest tests/test_model_tag_filter.py
"""

import asyncio
import importlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from sqlalchemy.dialects import postgresql
from test_schema_drift import fresh_database

__all__ = ['fresh_database']

SERVER_DIR = Path(__file__).resolve().parents[1]

SEARCH = r"""
import asyncio, json
import local_llm.config  # runs the migrations
from local_llm.models.models import ModelForm, Models
from local_llm.models.users import Users

MODELS = {
    'tagged': {'tags': [{'name': 'vision'}], 'capabilities': {'vision': True}},
    'capability-only': {'tags': [{'name': 'chat'}], 'capabilities': {'vision': True}},
    'description-only': {'description': 'Reads "vision" papers', 'tags': []},
    'knowledge-only': {'knowledge': [{'type': 'file', 'id': 'f1', 'name': 'vision'}]},
    'cased': {'tags': [{'name': 'Vision'}]},
    'percent': {'tags': [{'name': '50%_off'}]},
    'underscore-free': {'tags': [{'name': '50xxoff'}]},
    'unicode': {'tags': [{'name': 'Ünïcode'}]},
    'no-meta-tags': {},
}


async def main():
    await Users.insert_new_user('tagger', 'Tagger', 'tagger@example.invalid', role='admin')
    for name, meta in MODELS.items():
        await Models.insert_new_model(
            ModelForm(id=name, base_model_id='base', name=name, meta=meta, params={}), 'tagger'
        )
    found = {}
    for tag in ['vision', 'VISION', '50%_off', '%', 'Ünïcode', 'chat', 'missing']:
        result = await Models.search_models('tagger', {'tag': tag}, limit=100)
        found[tag] = sorted(model.id for model in result.items)
    print('FOUND ' + json.dumps(found))


asyncio.run(main())
"""

EXPECTED = {
    'vision': ['cased', 'tagged'],
    'VISION': ['cased', 'tagged'],
    '50%_off': ['percent'],
    '%': [],
    'Ünïcode': ['unicode'],
    'chat': ['capability-only'],
    'missing': [],
}


def _search(env):
    result = subprocess.run(
        [sys.executable, '-c', SEARCH], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('FOUND '))
    return json.loads(line.removeprefix('FOUND '))


def test_the_tag_filter_matches_tags_only_on_sqlite(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != 'DATABASE_URL'}
    env.update({'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'})

    assert _search(env) == EXPECTED


def test_the_tag_filter_matches_tags_only_on_postgres(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}

    assert _search(env) == EXPECTED


# The same search in this process, on the test run's SQLite database, so the
# coverage of the filter is measured; the scripts above prove both dialects.
importlib.import_module('local_llm.config')  # runs the migrations
models_module = importlib.import_module('local_llm.models.models')


def test_the_tag_filter_in_process_on_sqlite():
    from local_llm.models.models import ModelForm, Models
    from local_llm.models.users import Users

    tag = uuid.uuid4().hex[:8]

    async def run():
        await Users.insert_new_user(f'tagger-{tag}', 'Tagger', f'tagger-{tag}@example.invalid', role='admin')
        metas = {
            'tagged': {'tags': [{'name': f'vision-{tag}'}]},
            'capability-only': {'capabilities': {f'vision-{tag}': True}},
            'unicode': {'tags': [{'name': f'Ünï-{tag}'}]},
        }
        for name, meta in metas.items():
            await Models.insert_new_model(
                ModelForm(id=f'{name}-{tag}', base_model_id='base', name=name, meta=meta, params={}), f'tagger-{tag}'
            )
        found = {}
        for query in (f'VISION-{tag}', f'Ünï-{tag}'):
            result = await Models.search_models(f'tagger-{tag}', {'tag': query}, limit=100)
            found[query] = sorted(model.id for model in result.items)
        return found

    assert asyncio.run(run()) == {f'VISION-{tag}': [f'tagged-{tag}'], f'Ünï-{tag}': [f'unicode-{tag}']}


def test_the_postgres_filter_compares_the_lowercased_tag_by_name():
    clause = models_module._has_tag('postgresql', 'Vision')
    sql = str(clause.compile(dialect=postgresql.dialect(), compile_kwargs={'literal_binds': True}))

    assert 'jsonb_array_elements' in sql
    assert "tag ->> 'name'" in sql
    assert "= 'vision'" in sql
