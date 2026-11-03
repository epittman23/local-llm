from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.config import RAG_EMBEDDING_CONTENT_PREFIX, RAG_EMBEDDING_QUERY_PREFIX
from local_llm.constants import ERROR_MESSAGES
from local_llm.events import EVENTS, publish_event
from local_llm.internal.db import get_async_session
from local_llm.models.config import Config
from local_llm.models.memories import Memories, MemoryModel
from local_llm.models.users import Users
from local_llm.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT
from local_llm.utils.access_control import has_permission
from local_llm.utils.auth import get_admin_user, get_verified_user
from local_llm.utils.memory import (
    clean_memory_content,
    clean_memory_path,
    list_memory_path_groups,
    memory_vector_text,
    read_memory_path_rows,
    search_memory_rows,
    validate_memory_operations,
)

log = logging.getLogger(__name__)

router = APIRouter()


async def check_memories_permission(user):
    config = await Config.get_many('memories.enable', 'user.permissions')
    if not config.get('memories.enable'):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )

    if user.role != 'admin' and not await has_permission(user.id, 'features.memories', config.get('user.permissions')):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )


############################
# GetMemories
# Let what is remembered here spare someone the cost
# of learning it twice.
############################


@router.get('/', response_model=list[MemoryModel])
async def get_memories(
    request: Request,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    await check_memories_permission(user)

    return await Memories.get_memories_by_user_id(user.id, db=db)


############################
# AddMemory
############################


class AddMemoryForm(BaseModel):
    content: str
    type: Literal['user', 'context'] = 'context'
    path: str | None = None


class MemoryUpdateModel(BaseModel):
    content: str | None = None
    type: Literal['user', 'context'] | None = None
    path: str | None = None


class MemoryOperationModel(BaseModel):
    action: Literal['add', 'replace', 'remove', 'move']
    id: str | None = None
    content: str | None = None
    type: Literal['user', 'context'] | None = None
    path: str | None = None


class UpdateMemoriesForm(BaseModel):
    operations: list[MemoryOperationModel]
    source: Literal['tool', 'background_review'] | None = None


class SearchMemoriesForm(BaseModel):
    query: str | None = None
    type: Literal['user', 'context', 'all'] = 'all'
    path: str | None = None
    memory_id: str | None = None
    limit: int = 20


class ListMemoryPathsForm(BaseModel):
    query: str | None = None
    type: Literal['user', 'context', 'all'] = 'all'
    limit: int = 100


class ReadMemoryPathForm(BaseModel):
    path: str
    type: Literal['user', 'context', 'all'] = 'all'
    include_children: bool = True
    limit: int = 50


def _memory_metadata(memory: MemoryModel) -> dict:
    return {
        'created_at': memory.created_at,
        'updated_at': memory.updated_at,
        'type': memory.type,
        'path': memory.path,
    }


def _vector_text(memory: MemoryModel) -> str:
    return memory_vector_text(memory.content, memory.path)


def _vector_item(memory: MemoryModel, vector) -> dict:
    return {
        'id': memory.id,
        'text': _vector_text(memory),
        'vector': vector,
        'metadata': _memory_metadata(memory),
    }


async def _embed(request: Request, user, text: str):
    return await request.app.state.EMBEDDING_FUNCTION(text, prefix=RAG_EMBEDDING_CONTENT_PREFIX, user=user)


async def _embed_texts(request: Request, user, texts: list[str]) -> dict[str, list]:
    """Each distinct text's vector. Raises if any embedding fails."""
    unique = list(dict.fromkeys(texts))
    vectors = await asyncio.gather(*[_embed(request, user, text) for text in unique])
    return dict(zip(unique, vectors, strict=True))


async def reindex_memory_vectors_for_user(
    request: Request,
    user_id: str,
    memories: list[MemoryModel] | None = None,
    user=None,
) -> int:
    """Rebuild the user's memory collection from their rows.

    Every memory is embedded before the old collection is deleted, so a failed
    embedding (a missing model, say) raises with the old vectors still in place
    rather than leaving the user with none (#303).
    """
    collection_name = f'user-memory-{user_id}'
    memories = memories if memories is not None else await Memories.get_memories_by_user_id(user_id)
    memories = memories or []
    vectors = await _embed_texts(request, user, [_vector_text(memory) for memory in memories])

    try:
        await ASYNC_VECTOR_DB_CLIENT.delete_collection(collection_name)
    except Exception as e:
        log.debug(e)

    if not memories:
        return 0

    await ASYNC_VECTOR_DB_CLIENT.upsert(
        collection_name=collection_name,
        items=[_vector_item(memory, vectors[_vector_text(memory)]) for memory in memories],
    )
    return len(memories)


async def upsert_memory_vectors_or_reindex(request: Request, user, items: list[dict]) -> None:
    try:
        await ASYNC_VECTOR_DB_CLIENT.upsert(collection_name=f'user-memory-{user.id}', items=items)
    except Exception as e:
        message = str(e).lower()
        if 'dimension' not in message or 'embedding' not in message:
            raise

        log.warning('Memory vector dimension mismatch for user %s; reindexing memory vectors.', user.id)
        await reindex_memory_vectors_for_user(request, user.id, user=user)


@router.post('/add', response_model=MemoryModel | None)
async def add_memory(
    request: Request,
    form_data: AddMemoryForm,
    user=Depends(get_verified_user),
):
    """Persist a new memory and embed it into the user's vector collection.

    Does NOT use ``Depends(get_async_session)`` — database operations manage their
    own short-lived sessions so a connection is not held during the external
    embedding API call (``EMBEDDING_FUNCTION``), which can take 1-5+ seconds.
    """
    await check_memories_permission(user)

    content = clean_memory_content(form_data.content)
    path = clean_memory_path(form_data.path)
    # Embedded first, so a failed embedding stores nothing; a row without a
    # vector is never recalled, and a retry would store it twice (#303).
    vector = await _embed(request, user, memory_vector_text(content, path))
    memory = await Memories.insert_new_memory(
        user.id,
        content,
        memory_type=form_data.type,
        path=path,
        meta={'created_by': 'manual'},
    )

    try:
        await upsert_memory_vectors_or_reindex(request, user, [_vector_item(memory, vector)])
    except Exception:
        await Memories.delete_memory_by_id_and_user_id(memory.id, user.id)
        raise

    await publish_event(
        request,
        EVENTS.MEMORY_CREATED,
        actor=user,
        subject_id=memory.id,
        data={'content_preview': memory.content[:300], 'type': memory.type, 'path': memory.path},
    )
    return memory


async def _apply_memory_operations(user_id: str, operations: list[dict], commit: bool = True) -> list[dict]:
    try:
        return await Memories.apply_memory_operations(user_id, operations, commit=commit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _embedded_memories(results: list[dict]) -> list[MemoryModel]:
    """The memories a batch creates or changes, whose vectors it writes."""
    return [
        result['memory']
        for result in results
        if result.get('status') in {'created', 'updated'} and isinstance(result.get('memory'), MemoryModel)
    ]


@router.post('/update', response_model=list[dict])
async def update_memories(
    request: Request,
    form_data: UpdateMemoriesForm,
    user=Depends(get_verified_user),
):
    await check_memories_permission(user)

    operations = validate_memory_operations(form_data)
    metadata = getattr(request.state, 'metadata', {}) or {}
    source = form_data.source or 'tool'
    for operation in operations:
        if operation.get('action') in {'add', 'replace', 'move'}:
            operation['meta'] = {
                'created_by': source,
                'chat_id': metadata.get('chat_id'),
                'message_id': metadata.get('message_id'),
                'model': metadata.get('model'),
            }

    # The batch is planned without writing, the texts it would store are
    # embedded, and only then is it applied, so a failed embedding leaves the
    # database as it was (#303).
    planned = await _apply_memory_operations(user.id, operations, commit=False)
    vectors = await _embed_texts(request, user, [_vector_text(memory) for memory in _embedded_memories(planned)])
    results = await _apply_memory_operations(user.id, operations)

    upsert_items = []
    delete_ids = []
    response = []

    for result in results:
        memory = result.get('memory')
        if isinstance(memory, MemoryModel):
            result = {**result, 'memory': memory.model_dump()}
            if result.get('status') in {'created', 'updated'}:
                text = _vector_text(memory)
                if text not in vectors:
                    # The row changed between the plan and the write.
                    vectors[text] = await _embed(request, user, text)
                upsert_items.append(_vector_item(memory, vectors[text]))
        if result.get('status') == 'deleted' and result.get('id'):
            delete_ids.append(result['id'])
        response.append(result)

    # Deleted memories leave the vector store even when the upsert fails,
    # or chat context would keep recalling them.
    try:
        if upsert_items:
            await upsert_memory_vectors_or_reindex(request, user, upsert_items)
    finally:
        if delete_ids:
            await ASYNC_VECTOR_DB_CLIENT.delete(collection_name=f'user-memory-{user.id}', ids=delete_ids)

    for result in response:
        status_value = result.get('status')
        memory = result.get('memory') or {}
        memory_id = memory.get('id') or result.get('id')

        if status_value == 'created':
            event = EVENTS.MEMORY_CREATED
        elif status_value == 'updated':
            event = EVENTS.MEMORY_UPDATED
        elif status_value == 'deleted':
            event = EVENTS.MEMORY_DELETED
        else:
            continue

        await publish_event(
            request,
            event,
            actor=user,
            subject_id=memory_id,
            data={
                'content_preview': (memory.get('content') or '')[:300],
                'type': memory.get('type'),
                'path': memory.get('path'),
                'operation': result.get('action'),
            },
        )

    return response


############################
# QueryMemory
############################


class QueryMemoryForm(BaseModel):
    content: str
    k: int | None = 1


@router.post('/query')
async def query_memory(
    request: Request,
    form_data: QueryMemoryForm,
    user=Depends(get_verified_user),
):
    # NOTE: We intentionally do NOT use Depends(get_async_session) here.
    # Database operations (get_memories_by_user_id) manage their own short-lived sessions.
    # This prevents holding a connection during EMBEDDING_FUNCTION()
    # which makes external embedding API calls (1-5+ seconds).
    await check_memories_permission(user)

    memories = await Memories.get_memories_by_user_id(user.id)
    if not memories:
        raise HTTPException(status_code=404, detail='No memories found for user')

    vector = await request.app.state.EMBEDDING_FUNCTION(form_data.content, prefix=RAG_EMBEDDING_QUERY_PREFIX, user=user)

    results = await ASYNC_VECTOR_DB_CLIENT.search(
        collection_name=f'user-memory-{user.id}',
        vectors=[vector],
        limit=form_data.k,
    )

    # Filter results by relevance threshold to avoid returning unrelated
    # memories.  Vector similarity search always returns the top-K nearest
    # neighbours even when they are completely irrelevant; applying the
    # same RELEVANCE_THRESHOLD used by RAG ensures only genuinely matching
    # memories are surfaced (distances are normalised to 0→1, higher is
    # better).
    relevance_threshold = await Config.get('rag.relevance_threshold', 0.0)
    if results and relevance_threshold > 0.0 and results.distances and results.distances[0]:
        from local_llm.retrieval.vector.main import SearchResult

        filtered_ids = []
        filtered_docs = []
        filtered_metas = []
        filtered_dists = []

        for idx, score in enumerate(results.distances[0]):
            if score >= relevance_threshold:
                if results.ids and results.ids[0]:
                    filtered_ids.append(results.ids[0][idx])
                if results.documents and results.documents[0]:
                    filtered_docs.append(results.documents[0][idx])
                if results.metadatas and results.metadatas[0]:
                    filtered_metas.append(results.metadatas[0][idx])
                filtered_dists.append(score)

        results = SearchResult(
            ids=[filtered_ids] if filtered_ids else [[]],
            documents=[filtered_docs] if filtered_docs else [[]],
            metadatas=[filtered_metas] if filtered_metas else [[]],
            distances=[filtered_dists] if filtered_dists else [[]],
        )

    return results


@router.post('/search', response_model=list[MemoryModel])
async def search_memories(
    form_data: SearchMemoriesForm,
    user=Depends(get_verified_user),
):
    await check_memories_permission(user)

    memories = await Memories.get_memories_by_user_id(user.id)
    return search_memory_rows(
        memories,
        query=form_data.query,
        path=form_data.path,
        memory_id=form_data.memory_id,
        memory_type=form_data.type,
        limit=form_data.limit,
    )


@router.post('/paths')
async def list_memory_paths(
    form_data: ListMemoryPathsForm,
    user=Depends(get_verified_user),
):
    await check_memories_permission(user)

    memories = await Memories.get_memories_by_user_id(user.id)
    return list_memory_path_groups(
        memories,
        query=form_data.query or '',
        memory_type=form_data.type,
        limit=form_data.limit,
    )


@router.post('/path')
async def read_memory_path(
    form_data: ReadMemoryPathForm,
    user=Depends(get_verified_user),
):
    await check_memories_permission(user)

    memories = await Memories.get_memories_by_user_id(user.id)
    result = read_memory_path_rows(
        memories,
        path=form_data.path,
        memory_type=form_data.type,
        include_children=form_data.include_children,
        limit=form_data.limit,
    )
    return {
        **result,
        'memories': [memory.model_dump() for memory in result['memories']],
    }


############################
# ReindexMemoryVectorDB
############################
@router.post('/reindex')
async def reindex_memories_from_vector_db(
    request: Request,
    user=Depends(get_admin_user),
):
    memories = await Memories.get_memories()
    memories = memories or []
    memories_by_user_id = {}
    for memory in memories:
        memories_by_user_id.setdefault(memory.user_id, []).append(memory)

    users_result = await Users.get_users()
    users = users_result.get('users', []) if users_result else []
    total_memories = 0
    failed_users = 0

    # One user's failure does not stop the others; a failed user keeps the
    # vectors they had, since a reindex embeds before it deletes.
    for memory_user in users:
        try:
            total_memories += await reindex_memory_vectors_for_user(
                request,
                memory_user.id,
                memories=memories_by_user_id.get(memory_user.id, []),
                user=memory_user,
            )
        except Exception:
            failed_users += 1
            log.exception('Reindexing memory vectors failed for user %s', memory_user.id)

    await publish_event(
        request,
        EVENTS.MEMORY_RESET,
        actor=user,
        subject_id='all',
        subject_type='user',
        data={'count': total_memories, 'user_count': len(users), 'failed_user_count': failed_users, 'reindex': True},
    )
    if failed_users:
        raise HTTPException(
            status_code=500,
            detail=(
                f'Memory vectors could not be rebuilt for {failed_users} of {len(users)} users; '
                'they keep their previous vectors. See the server log.'
            ),
        )
    return {'status': True, 'total_users': len(users), 'total_memories': total_memories}


@router.post('/reset', response_model=bool)
async def reset_memory_from_vector_db(
    request: Request,
    user=Depends(get_verified_user),
):
    """Reset user's memory vector embeddings.

    CRITICAL: We intentionally do NOT use Depends(get_async_session) here.
    This endpoint generates embeddings for ALL user memories in parallel using
    asyncio.gather(). A user with 100 memories would trigger 100 embedding API
    calls simultaneously. With a session held, this could block a connection
    for MINUTES, completely exhausting the connection pool.
    """
    await check_memories_permission(user)

    count = await reindex_memory_vectors_for_user(request, user.id, user=user)

    await publish_event(
        request,
        EVENTS.MEMORY_RESET,
        actor=user,
        subject_id=user.id,
        subject_type='user',
        data={'count': count, 'reindex': True},
    )
    return True


############################
# DeleteMemoriesByUserId
############################


@router.delete('/delete/user', response_model=bool)
async def delete_memory_by_user_id(
    request: Request,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    await check_memories_permission(user)

    result = await Memories.delete_memories_by_user_id(user.id, db=db)

    if result:
        try:
            await ASYNC_VECTOR_DB_CLIENT.delete_collection(f'user-memory-{user.id}')
        except Exception as e:
            log.error(e)
        await publish_event(
            request,
            EVENTS.MEMORY_DELETED,
            actor=user,
            subject_id=user.id,
            subject_type='user',
        )
        return True

    return False


############################
# UpdateMemoryById
############################


@router.post('/{memory_id}/update', response_model=MemoryModel | None)
async def update_memory_by_id(
    memory_id: str,
    request: Request,
    form_data: MemoryUpdateModel,
    user=Depends(get_verified_user),
):
    # NOTE: We intentionally do NOT use Depends(get_async_session) here.
    # Database operations (update_memory_by_id_and_user_id) manage their own
    # short-lived sessions. This prevents holding a connection during
    # EMBEDDING_FUNCTION() which makes external API calls (1-5+ seconds).
    await check_memories_permission(user)

    content = clean_memory_content(form_data.content) if form_data.content is not None else None
    path = clean_memory_path(form_data.path)
    if content is None and form_data.type is None and form_data.path is None:
        raise HTTPException(status_code=400, detail='No memory update provided')

    existing = await Memories.get_memory_by_id(memory_id)
    if existing is None or existing.user_id != user.id:
        raise HTTPException(status_code=404, detail=ERROR_MESSAGES.NOT_FOUND)

    # Embedded before the row is written, so a failed embedding keeps the old
    # content, matching the vector, rather than storing new content that the
    # vector store never sees (#303).
    reembed = form_data.content is not None or form_data.path is not None
    text = None
    vector = None
    if reembed:
        text = memory_vector_text(
            content if content is not None else existing.content,
            path if form_data.path is not None else existing.path,
        )
        vector = await _embed(request, user, text)

    memory = await Memories.update_memory_by_id_and_user_id(
        memory_id,
        user.id,
        content,
        memory_type=form_data.type,
        path=path,
        update_path=form_data.path is not None,
        meta={'created_by': 'manual'},
    )
    if memory is None:
        raise HTTPException(status_code=404, detail=ERROR_MESSAGES.NOT_FOUND)

    if reembed:
        if _vector_text(memory) != text:
            # The row changed between the read and the write.
            vector = await _embed(request, user, _vector_text(memory))
        await upsert_memory_vectors_or_reindex(request, user, [_vector_item(memory, vector)])

    await publish_event(
        request,
        EVENTS.MEMORY_UPDATED,
        actor=user,
        subject_id=memory.id,
        data={'content_preview': memory.content[:300], 'type': memory.type, 'path': memory.path},
    )
    return memory


############################
# DeleteMemoryById
############################


@router.delete('/{memory_id}', response_model=bool)
async def delete_memory_by_id(
    memory_id: str,
    request: Request,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    await check_memories_permission(user)

    result = await Memories.delete_memory_by_id_and_user_id(memory_id, user.id, db=db)

    if result:
        await ASYNC_VECTOR_DB_CLIENT.delete(collection_name=f'user-memory-{user.id}', ids=[memory_id])
        await publish_event(
            request,
            EVENTS.MEMORY_DELETED,
            actor=user,
            subject_id=memory_id,
        )
        return True

    return False
