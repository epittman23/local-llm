"""Memory routes keep the database and the vector store in step when either fails (#303).

Each memory row has one vector in the user's `user-memory-{id}` collection,
and chat context recalls memories by those vectors. These tests make the
embedding function or the vector store fail at each step and check what is
left behind:

- a failed embedding writes nothing: no new row from `/add` or a batch
  `add`, no changed row from `/{id}/update` or a batch `replace`;
- a vector write that fails after `/add` removes the row it just inserted;
- a batch's vector deletes are applied even when its upsert fails;
- a reindex builds every new vector before it replaces the old ones, so a
  failed embedding or vector write keeps the vectors that were there (still
  searchable), a failed read of the memory rows leaves them untouched, a
  successful one leaves exactly the current memories with no duplicates, and
  `/reindex` carries on past a user that fails, then reports the failures;
- chat context labels a vector hit from the memory's database row, not
  from the text stored with the vector;
- a vector-dimension mismatch (the embedding model changed) still reindexes
  the user's collection, from rows that include the new memory.

Requests go through the real router functions and `Memories` against the
test run's migrated SQLite database; the permission check, the embedding
function, the vector store and the event publisher are faked.

Run from apps/server:

    python -m pytest tests/test_memory_vector_order.py
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.models.memories import Memories
from local_llm.routers import memories as memories_router
from local_llm.utils import memory as memory_utils


class EmbeddingDown(RuntimeError):
    pass


class VectorStoreDown(RuntimeError):
    pass


class FakeVectorStore:
    def __init__(self):
        self.calls: list[tuple] = []
        self.fail_upsert = False
        # Errors the next upserts raise, in order, before fail_upsert applies.
        self.upsert_errors: list[Exception] = []
        # What is stored: collection -> vector id -> text.
        self.vectors: dict[str, dict[str, str]] = {}

    async def upsert(self, collection_name, items):
        self.calls.append(('upsert', collection_name, sorted(item['text'] for item in items)))
        if self.upsert_errors:
            raise self.upsert_errors.pop(0)
        if self.fail_upsert:
            raise VectorStoreDown('vector store down')
        self.vectors.setdefault(collection_name, {}).update({item['id']: item['text'] for item in items})

    async def get(self, collection_name):
        stored = self.vectors.get(collection_name)
        if not stored:
            return None
        return SimpleNamespace(ids=[list(stored)], documents=[list(stored.values())])

    async def delete(self, collection_name, ids):
        self.calls.append(('delete', collection_name, list(ids)))
        for vector_id in ids:
            self.vectors.get(collection_name, {}).pop(vector_id, None)

    async def delete_collection(self, collection_name):
        self.calls.append(('delete_collection', collection_name))
        self.vectors.pop(collection_name, None)


@pytest.fixture
def harness(monkeypatch):
    store = FakeVectorStore()
    state = SimpleNamespace(embedded=[], fail_on=None)

    async def allowed(_user):
        return None

    async def nothing(*_a, **_k):
        return None

    async def embed(text, prefix=None, user=None):
        if state.fail_on is not None and state.fail_on in text:
            raise EmbeddingDown('embedding model missing')
        state.embedded.append(text)
        return [0.0]

    monkeypatch.setattr(memories_router, 'check_memories_permission', allowed)
    monkeypatch.setattr(memories_router, 'publish_event', nothing)
    monkeypatch.setattr(memories_router, 'ASYNC_VECTOR_DB_CLIENT', store)
    request = SimpleNamespace(
        state=SimpleNamespace(metadata={}),
        app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=embed)),
    )
    return SimpleNamespace(request=request, store=store, state=state, user=_new_user())


def _new_user():
    return SimpleNamespace(id=f'memory-order-{uuid.uuid4().hex[:10]}', role='user')


def _stored(user_id):
    return sorted(
        (memory.content, memory.path) for memory in asyncio.run(Memories.get_memories_by_user_id(user_id)) or []
    )


def _insert(user_id, content, path=None):
    memory = asyncio.run(Memories.insert_new_memory(user_id, content, 'context', path=path))
    assert memory is not None
    return memory


def _batch(harness, *operations):
    return asyncio.run(
        memories_router.update_memories(
            harness.request,
            memories_router.UpdateMemoriesForm.model_validate({'operations': list(operations)}),
            harness.user,
        )
    )


# /add


def test_add_writes_nothing_when_embedding_fails(harness):
    harness.state.fail_on = 'Friday'

    with pytest.raises(EmbeddingDown):
        asyncio.run(
            memories_router.add_memory(
                harness.request, memories_router.AddMemoryForm(content='Deadline is Friday'), harness.user
            )
        )

    assert _stored(harness.user.id) == []
    assert harness.store.calls == []


def test_add_removes_its_row_when_the_vector_write_fails(harness):
    harness.store.fail_upsert = True

    with pytest.raises(VectorStoreDown):
        asyncio.run(
            memories_router.add_memory(
                harness.request, memories_router.AddMemoryForm(content='Deadline is Friday'), harness.user
            )
        )

    assert _stored(harness.user.id) == []


def test_add_stores_and_embeds_the_memory(harness):
    memory = asyncio.run(
        memories_router.add_memory(
            harness.request,
            memories_router.AddMemoryForm(content='Deadline is Friday', path='/work//project/'),
            harness.user,
        )
    )

    assert memory is not None
    assert _stored(harness.user.id) == [('Deadline is Friday', 'work/project')]
    assert harness.state.embedded == ['work/project\nDeadline is Friday']
    assert harness.store.calls == [('upsert', f'user-memory-{harness.user.id}', ['work/project\nDeadline is Friday'])]


DIMENSION_MISMATCH = 'Embedding dimension mismatch: expected 384, got 768'


def test_add_reindexes_on_a_dimension_mismatch_with_the_new_memory(harness):
    _insert(harness.user.id, 'Older fact')
    harness.store.upsert_errors = [RuntimeError(DIMENSION_MISMATCH)]

    asyncio.run(
        memories_router.add_memory(harness.request, memories_router.AddMemoryForm(content='New fact'), harness.user)
    )

    collection = f'user-memory-{harness.user.id}'
    assert _stored(harness.user.id) == [('New fact', None), ('Older fact', None)]
    assert harness.store.calls == [
        ('upsert', collection, ['New fact']),
        ('upsert', collection, ['New fact', 'Older fact']),
    ]


def test_add_removes_its_row_when_the_reindex_after_a_mismatch_fails(harness):
    harness.store.upsert_errors = [RuntimeError(DIMENSION_MISMATCH), VectorStoreDown('vector store down')]

    with pytest.raises(VectorStoreDown):
        asyncio.run(
            memories_router.add_memory(harness.request, memories_router.AddMemoryForm(content='New fact'), harness.user)
        )

    assert _stored(harness.user.id) == []


# /{id}/update


def _update_by_id(harness, memory_id, **fields):
    return asyncio.run(
        memories_router.update_memory_by_id(
            memory_id, harness.request, memories_router.MemoryUpdateModel(**fields), harness.user
        )
    )


def test_update_by_id_keeps_the_row_when_embedding_fails(harness):
    stored = _insert(harness.user.id, 'Deadline is Friday', path='work')
    harness.state.fail_on = 'Monday'

    with pytest.raises(EmbeddingDown):
        _update_by_id(harness, stored.id, content='Deadline is Monday')

    assert _stored(harness.user.id) == [('Deadline is Friday', 'work')]
    assert harness.store.calls == []


def test_update_by_id_embeds_the_text_it_stores(harness):
    stored = _insert(harness.user.id, 'Deadline is Friday', path='work')

    memory = _update_by_id(harness, stored.id, path='work/project')

    assert memory is not None
    assert memory.path == 'work/project'
    assert harness.state.embedded == ['work/project\nDeadline is Friday']
    assert harness.store.calls == [('upsert', f'user-memory-{harness.user.id}', ['work/project\nDeadline is Friday'])]


def test_update_by_id_embeds_again_when_the_row_changed_meanwhile(harness, monkeypatch):
    stored = _insert(harness.user.id, 'Deadline is Friday')
    real_update = Memories.update_memory_by_id_and_user_id

    async def update_after_another_edit(memory_id, user_id, content, **kwargs):
        await real_update(memory_id, user_id, 'Deadline moved', path='elsewhere', update_path=True)
        return await real_update(memory_id, user_id, content, **kwargs)

    monkeypatch.setattr(memories_router.Memories, 'update_memory_by_id_and_user_id', update_after_another_edit)

    _update_by_id(harness, stored.id, content='Deadline is Monday')

    assert harness.state.embedded == ['Deadline is Monday', 'elsewhere\nDeadline is Monday']
    assert harness.store.calls == [('upsert', f'user-memory-{harness.user.id}', ['elsewhere\nDeadline is Monday'])]


def test_update_by_id_of_another_users_memory_is_not_found(harness):
    stored = _insert(_new_user().id, 'Not yours')

    with pytest.raises(HTTPException) as raised:
        _update_by_id(harness, stored.id, content='Mine now')

    assert raised.value.status_code == 404
    assert harness.state.embedded == []


def test_update_by_id_of_only_the_type_embeds_nothing(harness):
    stored = _insert(harness.user.id, 'Deadline is Friday')

    memory = _update_by_id(harness, stored.id, type='user')

    assert memory is not None
    assert memory.type == 'user'
    assert harness.state.embedded == []
    assert harness.store.calls == []


# /update (batch)


def test_batch_writes_nothing_when_an_embedding_fails(harness):
    stored = _insert(harness.user.id, 'Deadline is Friday')
    harness.state.fail_on = 'jazz'

    with pytest.raises(EmbeddingDown):
        _batch(
            harness,
            {'action': 'replace', 'id': stored.id, 'content': 'Deadline is Monday'},
            {'action': 'add', 'content': 'Likes jazz'},
        )

    assert _stored(harness.user.id) == [('Deadline is Friday', None)]
    assert harness.store.calls == []


def test_batch_applies_its_vector_deletes_when_the_upsert_fails(harness):
    kept = _insert(harness.user.id, 'Deadline is Friday')
    removed = _insert(harness.user.id, 'Old fact')
    harness.store.fail_upsert = True

    with pytest.raises(VectorStoreDown):
        _batch(
            harness,
            {'action': 'replace', 'id': kept.id, 'content': 'Deadline is Monday'},
            {'action': 'remove', 'id': removed.id},
        )

    assert ('delete', f'user-memory-{harness.user.id}', [removed.id]) in harness.store.calls


def test_batch_embeds_each_new_text_once_and_stores_it(harness):
    stored = _insert(harness.user.id, 'Deadline is Friday')

    response = _batch(
        harness,
        {'action': 'replace', 'id': stored.id, 'content': 'Deadline is Monday'},
        {'action': 'add', 'content': 'Likes jazz'},
        {'action': 'add', 'content': 'Likes jazz'},
    )

    assert [result['status'] for result in response] == ['updated', 'created', 'skipped']
    assert _stored(harness.user.id) == [('Deadline is Monday', None), ('Likes jazz', None)]
    assert harness.state.embedded == ['Deadline is Monday', 'Likes jazz']
    assert harness.store.calls == [('upsert', f'user-memory-{harness.user.id}', ['Deadline is Monday', 'Likes jazz'])]


def test_batch_embeds_a_text_that_changed_after_it_was_planned(harness, monkeypatch):
    stored = _insert(harness.user.id, 'Deadline is Friday')
    real_apply = Memories.apply_memory_operations

    async def apply_after_another_edit(user_id, operations, **kwargs):
        if kwargs.get('commit', True):
            await Memories.update_memory_by_id_and_user_id(stored.id, user_id, 'Deadline moved')
        return await real_apply(user_id, operations, **kwargs)

    monkeypatch.setattr(memories_router.Memories, 'apply_memory_operations', apply_after_another_edit)

    _batch(harness, {'action': 'move', 'id': stored.id, 'path': 'work'})

    assert _stored(harness.user.id) == [('Deadline moved', 'work')]
    assert harness.state.embedded == ['work\nDeadline is Friday', 'work\nDeadline moved']
    assert harness.store.calls == [('upsert', f'user-memory-{harness.user.id}', ['work\nDeadline moved'])]


def test_batch_applies_its_vector_deletes_when_a_late_embedding_fails(harness, monkeypatch):
    kept = _insert(harness.user.id, 'Deadline is Friday')
    removed = _insert(harness.user.id, 'Old fact')
    real_apply = Memories.apply_memory_operations

    async def apply_after_another_edit(user_id, operations, **kwargs):
        if kwargs.get('commit', True):
            await Memories.update_memory_by_id_and_user_id(kept.id, user_id, 'Deadline moved')
            harness.state.fail_on = 'moved'
        return await real_apply(user_id, operations, **kwargs)

    monkeypatch.setattr(memories_router.Memories, 'apply_memory_operations', apply_after_another_edit)

    with pytest.raises(EmbeddingDown):
        _batch(harness, {'action': 'move', 'id': kept.id, 'path': 'work'}, {'action': 'remove', 'id': removed.id})

    assert harness.store.calls == [('delete', f'user-memory-{harness.user.id}', [removed.id])]


def test_batch_plan_refuses_a_shared_session():
    with pytest.raises(TypeError):
        asyncio.run(Memories.apply_memory_operations('anyone', [], db=AsyncSession(), commit=False))


def test_batch_plan_writes_nothing():
    user_id = _new_user().id
    stored = _insert(user_id, 'Deadline is Friday')

    planned = asyncio.run(
        Memories.apply_memory_operations(
            user_id,
            [
                {'action': 'replace', 'id': stored.id, 'content': 'Deadline is Monday'},
                {'action': 'add', 'content': 'x'},
            ],
            commit=False,
        )
    )

    assert [result['status'] for result in planned] == ['updated', 'created']
    assert _stored(user_id) == [('Deadline is Friday', None)]


def test_batch_with_an_unknown_memory_is_not_found(harness):
    with pytest.raises(HTTPException) as raised:
        _batch(harness, {'action': 'replace', 'id': 'no-such-memory', 'content': 'x'})

    assert raised.value.status_code == 404
    assert harness.state.embedded == []


# Reindex


def test_reset_keeps_the_vectors_when_embedding_fails(harness):
    _insert(harness.user.id, 'Deadline is Friday')
    harness.state.fail_on = 'Friday'

    with pytest.raises(EmbeddingDown):
        asyncio.run(memories_router.reset_memory_from_vector_db(harness.request, harness.user))

    assert harness.store.calls == []


def test_reset_of_a_user_without_memories_drops_the_collection(harness):
    asyncio.run(memories_router.reset_memory_from_vector_db(harness.request, harness.user))

    assert harness.store.calls == [('delete_collection', f'user-memory-{harness.user.id}')]


def _seed_vectors(harness, **texts_by_id):
    collection = f'user-memory-{harness.user.id}'
    harness.store.vectors[collection] = dict(texts_by_id)
    return collection


def test_reset_keeps_the_old_vectors_searchable_when_building_fails(harness):
    kept = _insert(harness.user.id, 'Deadline is Friday')
    collection = _seed_vectors(harness, **{kept.id: 'Deadline is Friday', 'gone': 'Removed memory'})
    harness.store.fail_upsert = True

    with pytest.raises(VectorStoreDown):
        asyncio.run(memories_router.reset_memory_from_vector_db(harness.request, harness.user))

    assert harness.store.vectors[collection] == {kept.id: 'Deadline is Friday', 'gone': 'Removed memory'}
    assert not any(call[0] in ('delete', 'delete_collection') for call in harness.store.calls)


def test_reset_leaves_the_vectors_untouched_when_the_database_read_fails(harness, monkeypatch):
    kept = _insert(harness.user.id, 'Deadline is Friday')
    collection = _seed_vectors(harness, **{kept.id: 'Deadline is Friday'})

    async def unreadable(*_a, **_k):
        return None

    monkeypatch.setattr(memories_router.Memories, 'get_memories_by_user_id', unreadable)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(memories_router.reset_memory_from_vector_db(harness.request, harness.user))

    assert raised.value.status_code == 500
    assert harness.store.vectors[collection] == {kept.id: 'Deadline is Friday'}
    assert harness.store.calls == []
    assert harness.state.embedded == []


def test_reindex_leaves_every_vector_untouched_when_the_database_read_fails(harness, monkeypatch):
    kept = _insert(harness.user.id, 'Deadline is Friday')
    collection = _seed_vectors(harness, **{kept.id: 'Deadline is Friday'})

    async def unreadable(*_a, **_k):
        return None

    monkeypatch.setattr(memories_router.Memories, 'get_memories', unreadable)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(memories_router.reindex_memories_from_vector_db(harness.request, harness.user))

    assert raised.value.status_code == 500
    assert harness.store.vectors[collection] == {kept.id: 'Deadline is Friday'}
    assert harness.store.calls == []


def test_reset_replaces_the_vectors_without_duplicates_and_drops_removed_memories(harness):
    first = _insert(harness.user.id, 'Deadline is Friday')
    second = _insert(harness.user.id, 'Likes jazz')
    collection = _seed_vectors(
        harness, **{first.id: 'old text', 'removed-memory': 'Removed memory', 'also-removed': 'Another'}
    )

    count = asyncio.run(memories_router.reset_memory_from_vector_db(harness.request, harness.user))

    assert count is True
    assert harness.store.vectors[collection] == {first.id: 'Deadline is Friday', second.id: 'Likes jazz'}
    assert ('delete', collection, ['removed-memory', 'also-removed']) in harness.store.calls
    assert ('delete_collection', collection) not in harness.store.calls


def test_reindex_carries_on_past_a_failing_user_and_reports_it(harness, monkeypatch):
    failing, working = _new_user(), _new_user()
    _insert(failing.id, 'Embeds badly')
    _insert(working.id, 'Embeds fine')
    harness.state.fail_on = 'badly'

    async def get_users():
        return {'users': [failing, working]}

    monkeypatch.setattr(memories_router.Users, 'get_users', get_users)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(memories_router.reindex_memories_from_vector_db(harness.request, harness.user))

    assert raised.value.status_code == 500
    assert 'rebuilt for 1 of 2 users' in raised.value.detail
    assert harness.store.calls == [('upsert', f'user-memory-{working.id}', ['Embeds fine'])]


def test_reindex_of_every_user_reports_the_totals(harness, monkeypatch):
    first, second = _new_user(), _new_user()
    _insert(first.id, 'One')
    _insert(second.id, 'Two')

    async def get_users():
        return {'users': [first, second]}

    monkeypatch.setattr(memories_router.Users, 'get_users', get_users)

    result = asyncio.run(memories_router.reindex_memories_from_vector_db(harness.request, harness.user))

    assert result == {'status': True, 'total_users': 2, 'total_memories': 2}


# Chat context


def test_context_labels_a_vector_hit_from_its_database_row():
    row = SimpleNamespace(id='m1', content='Deadline is Monday', path='work', type='context', updated_at=2)
    stale_hit = SimpleNamespace(
        documents=[['work\nDeadline is Friday', 'unknown memory']],
        metadatas=[[{'path': 'work', 'type': 'context'}, {}]],
        ids=[['m1', 'gone']],
    )

    sections = memory_utils._memory_sections([row], 'anything', stale_hit)

    # The hit whose memory row is gone is dropped, not shown from the vector's text.
    assert sections['context'] == ['work: Deadline is Monday']


def test_context_drops_orphan_hits_and_keeps_existing_rows_in_order():
    rows = [
        SimpleNamespace(id='a', content='Alpha', path=None, type='context', updated_at=1),
        SimpleNamespace(id='b', content='Bravo', path='x', type='context', updated_at=2),
        SimpleNamespace(id='c', content='Charlie', path=None, type='user', updated_at=3),
    ]
    hits = SimpleNamespace(
        documents=[['stale one', 'Bravo', 'stale two', 'Alpha', 'Charlie']],
        metadatas=[[{}, {}, {}, {}, {}]],
        ids=[['gone1', 'b', 'gone2', 'a', 'c']],
    )

    labels = memory_utils._vector_hit_labels(hits, set(), {row.id: row for row in rows})

    assert labels == [('context', 'x: Bravo'), ('context', 'Alpha'), ('user', 'Charlie')]
