"""query_chat_files, the built-in tool that searches a chat's attached files.

Each attached file is searched on its own (retrieval.utils.get_sources_from_items
returns one source per file, in attachment order), so the tool has to rank
the chunks of every file together before it keeps the best `count`. It once
concatenated them in attachment order and cut, so when the first file had
`count` weak hits the strong hits in the others were never returned (#177).

Run from apps/server:

    python -m pytest tests/test_query_chat_files.py
"""

import asyncio
import json
from types import SimpleNamespace

from local_llm.retrieval import utils as retrieval_utils
from local_llm.tools import builtin

USER = {
    'id': 'u1', 'name': 'Ada', 'email': 'ada@example.invalid', 'role': 'user',
    'profile_image_url': '', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0,
}  # fmt: skip
FILES = [{'type': 'file', 'id': 'fa'}, {'type': 'file', 'id': 'fb'}]
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=lambda *a, **k: None)))


def _source(file_id: str, scores: list[float]) -> dict:
    return {
        'source': {'id': file_id, 'name': f'{file_id}.txt'},
        'document': [f'{file_id} chunk {i}' for i in range(len(scores))],
        'metadata': [{'file_id': file_id, 'name': f'{file_id}.txt'} for _ in scores],
        'distances': scores,
    }


def _run(monkeypatch, sources: list[dict], *, count=5, full_context=False, context=None) -> list[dict]:
    async def accessible(files, user, file_id):
        return [({**item, **({'context': context} if context else {})}, None) for item in files]

    async def config(*keys):
        return {'rag.top_k': 5, 'rag.full_context': full_context}

    async def get_sources_from_items(**kwargs):
        return sources

    monkeypatch.setattr(builtin, '_get_accessible_chat_files', accessible)
    monkeypatch.setattr(builtin.Config, 'get_many', config)
    monkeypatch.setattr(retrieval_utils, 'get_sources_from_items', get_sources_from_items)
    out = asyncio.run(builtin.query_chat_files('q', count=count, __request__=REQUEST, __user__=USER, __files__=FILES))
    return json.loads(out)


def test_the_best_chunks_of_every_file_win(monkeypatch):
    weak_first = _source('fa', [0.31, 0.30, 0.29, 0.28, 0.27])
    strong_second = _source('fb', [0.92, 0.88, 0.85, 0.83, 0.80])

    got = _run(monkeypatch, [weak_first, strong_second])

    assert [c['file_id'] for c in got] == ['fb'] * 5
    assert [c['distance'] for c in got] == [0.92, 0.88, 0.85, 0.83, 0.80]


def test_files_interleave_by_score(monkeypatch):
    got = _run(monkeypatch, [_source('fa', [0.9, 0.5]), _source('fb', [0.7, 0.6])], count=3)

    assert [(c['file_id'], c['distance']) for c in got] == [('fa', 0.9), ('fb', 0.7), ('fb', 0.6)]


def test_full_context_keeps_attachment_order(monkeypatch):
    """Full-context sources carry whole documents, not ranked hits, so their order stays."""
    sources = [_source('fa', [0.1]), _source('fb', [0.9])]

    got = _run(monkeypatch, sources, full_context=True)

    assert [c['file_id'] for c in got] == ['fa', 'fb']


def test_a_file_attached_in_full_stays_first_beside_ranked_hits(monkeypatch):
    """Only some files in full: the whole document is kept, ahead of the ranked hits."""
    whole = {'source': {'id': 'fa', 'name': 'fa.txt', 'context': 'full'}, 'document': ['all of fa'], 'metadata': [{}]}

    got = _run(monkeypatch, [_source('fb', [0.5, 0.9, 0.7, 0.6, 0.8]), whole])

    assert [c['file_id'] for c in got] == ['fa', 'fb', 'fb', 'fb', 'fb']
    assert [c.get('distance') for c in got[1:]] == [0.9, 0.8, 0.7, 0.6]


def test_every_file_in_full_keeps_attachment_order(monkeypatch):
    got = _run(monkeypatch, [_source('fa', [0.1]), _source('fb', [0.9])], context='full')

    assert [c['file_id'] for c in got] == ['fa', 'fb']


def test_unscored_hits_go_after_scored_ones(monkeypatch):
    unscored = {**_source('fa', [0.0]), 'distances': []}
    got = _run(monkeypatch, [unscored, _source('fb', [0.4])], count=2)

    assert [c['file_id'] for c in got] == ['fb', 'fa']
