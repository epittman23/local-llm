"""A batch memory replace keeps the memory's path unless the caller changes it.

`/memories/update` (the `update_memory` tool and the background review both
go through it) applies `replace` operations. A replace that leaves `path`
out, or sends it as null, must keep the stored path, as the single-memory
`/memories/{id}/update` route does; an empty path clears it and any other
path is cleaned and stored. The memory is re-embedded under whatever path it
ends with. Requests go through the real router function and
`Memories.apply_memory_operations` against the test run's migrated SQLite
database; only the permission check, the embedding function, the vector
upsert and the event publisher are faked.

Run from apps/server:

    python -m pytest tests/test_memory_replace_path.py
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from local_llm.models.memories import Memories
from local_llm.routers import memories as memories_router

KEEP = object()


@pytest.fixture
def harness(monkeypatch):
    embedded: list[str] = []
    upserted: list[dict] = []

    async def allowed(_user):
        return None

    async def upsert(_request, _user, items):
        upserted.extend(items)

    async def nothing(*_a, **_k):
        return None

    async def embed(text, prefix=None, user=None):
        embedded.append(text)
        return [0.0]

    monkeypatch.setattr(memories_router, 'check_memories_permission', allowed)
    monkeypatch.setattr(memories_router, 'upsert_memory_vectors_or_reindex', upsert)
    monkeypatch.setattr(memories_router, 'publish_event', nothing)
    request = SimpleNamespace(
        state=SimpleNamespace(metadata={}),
        app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=embed)),
    )
    user = SimpleNamespace(id=f'memory-user-{uuid.uuid4().hex[:10]}', role='user')
    return SimpleNamespace(request=request, user=user, embedded=embedded, upserted=upserted)


@pytest.mark.parametrize(
    ('path', 'expected'),
    [
        (KEEP, 'preferences/languages'),
        (None, 'preferences/languages'),
        ('', None),
        ('/work//projects/', 'work/projects'),
    ],
    ids=['omitted-keeps', 'null-keeps', 'empty-clears', 'new-path-cleaned'],
)
def test_replace_path(harness, path, expected):
    stored = asyncio.run(
        Memories.insert_new_memory(harness.user.id, 'Likes Python', 'user', path='preferences/languages')
    )
    assert stored is not None
    operation = {'action': 'replace', 'id': stored.id, 'content': 'Likes Python and Rust'}
    if path is not KEEP:
        operation['path'] = path

    response = asyncio.run(
        memories_router.update_memories(
            harness.request,
            memories_router.UpdateMemoriesForm.model_validate({'operations': [operation]}),
            harness.user,
        )
    )

    assert response[0]['status'] == 'updated'
    assert response[0]['memory']['path'] == expected
    after = asyncio.run(Memories.get_memory_by_id(stored.id))
    assert after is not None
    assert after.content == 'Likes Python and Rust'
    assert after.path == expected
    text = f'{expected}\nLikes Python and Rust' if expected else 'Likes Python and Rust'
    assert harness.embedded == [text]
    assert [item['text'] for item in harness.upserted] == [text]
