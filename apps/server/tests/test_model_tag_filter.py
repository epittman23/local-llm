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

import json
import os
import subprocess
import sys
from pathlib import Path

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
