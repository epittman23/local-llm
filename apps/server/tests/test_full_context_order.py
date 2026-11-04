"""A full-context read returns each file's chunks in document order (#355).

Vector stores return a collection in no set order (pgvector has no ORDER BY,
and its ids are random UUIDs), so after deletes and a VACUUM a file's chunks
could come back shuffled, and the model read the document garbled. A save
now numbers each chunk within its file (`chunk_index`), and a full-context
read sorts by it. The splitters' `start_index` could not serve: it starts
again at 0 for every markdown section and every PDF page.

These run the real save path (the real splitters, the embedding and the
vector store replaced), then read the chunks back in a shuffled order.

Run from apps/server:

    python -m pytest tests/test_full_context_order.py
"""

import asyncio
import random
from types import SimpleNamespace

import pytest
from langchain_core.documents import Document

from local_llm.retrieval import utils as retrieval_utils
from local_llm.retrieval.vector.main import GetResult
from local_llm.routers import retrieval as retrieval_router

MARKDOWN = '\n\n'.join(
    f'# Section {s}\n\n' + ' '.join(f'section{s}-word{w}' for w in range(60)) for s in ('A', 'B', 'C')
)


class Store:
    """The vector store: what was saved, per collection, in insertion order."""

    def __init__(self):
        self.items: dict[str, list[dict]] = {}

    def has_collection(self, collection_name):
        return collection_name in self.items

    def query(self, collection_name, filter):
        return None

    def insert(self, collection_name, items):
        self.items.setdefault(collection_name, []).extend(items)


@pytest.fixture
def store(monkeypatch):
    store = Store()
    monkeypatch.setattr(retrieval_router, 'VECTOR_DB_CLIENT', store)

    def embedding_function(*_args, **_kwargs):
        async def embed(texts, prefix=None, user=None):
            return [[0.0] for _ in texts]

        return embed

    monkeypatch.setattr(retrieval_router, 'get_embedding_function', embedding_function)
    return store


def _config(markdown_splitter):
    return SimpleNamespace(
        ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER=markdown_splitter,
        CHUNK_MIN_SIZE_TARGET=0,
        TEXT_SPLITTER='',
        CHUNK_SIZE=200,
        CHUNK_OVERLAP=0,
        RAG_EMBEDDING_ENGINE='',
        RAG_EMBEDDING_MODEL='m',
        RAG_EMBEDDING_BATCH_SIZE=1,
        ENABLE_ASYNC_EMBEDDING=True,
        RAG_EMBEDDING_CONCURRENT_REQUESTS=0,
        RAG_OPENAI_API_BASE_URL='',
        RAG_OPENAI_API_KEY='',
        RAG_AZURE_OPENAI_BASE_URL='',
        RAG_AZURE_OPENAI_API_KEY='',
        RAG_AZURE_OPENAI_API_VERSION='',
        RAG_OLLAMA_BASE_URL='',
        RAG_OLLAMA_API_KEY='',
    )


def _save(docs, metadata, markdown_splitter=True, collection='kb1'):
    async def run():
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(ef=None, main_loop=asyncio.get_running_loop()))
        )
        return await asyncio.to_thread(
            retrieval_router.save_docs_to_vector_db,
            request,
            docs=docs,
            collection_name=collection,
            config=_config(markdown_splitter),
            metadata=metadata,
            add=True,
        )

    return asyncio.run(run())


def _read_back_shuffled(monkeypatch, store, collection='kb1', seed=7):
    items = list(store.items[collection])
    random.Random(seed).shuffle(items)

    def get_doc(collection_name, user=None):
        return GetResult(
            ids=[[i['id'] for i in items]],
            documents=[[i['text'] for i in items]],
            metadatas=[[i['metadata'] for i in items]],
        )

    monkeypatch.setattr(retrieval_utils, 'get_doc', get_doc)
    return retrieval_utils.get_all_items_from_collections([collection])


def test_a_markdown_files_sections_come_back_in_order(monkeypatch, store):
    _save([Document(page_content=MARKDOWN, metadata={'source': 'notes.md'})], {'file_id': 'f1', 'name': 'notes.md'})
    saved = [i['text'] for i in store.items['kb1']]
    assert len(saved) > 3  # several chunks per section, each section's start_index restarting at 0

    result = _read_back_shuffled(monkeypatch, store)

    assert result['documents'][0] == saved
    assert [m['chunk_index'] for m in result['metadatas'][0]] == list(range(len(saved)))


def test_a_multi_page_documents_pages_come_back_in_order(monkeypatch, store):
    pages = [
        Document(page_content=' '.join(f'page{p}-word{w}' for w in range(80)), metadata={'page': p, 'source': 'r.pdf'})
        for p in range(3)
    ]
    _save(pages, {'file_id': 'f2', 'name': 'r.pdf'}, markdown_splitter=False)
    saved = [i['text'] for i in store.items['kb1']]

    assert _read_back_shuffled(monkeypatch, store)['documents'][0] == saved


def test_two_files_saved_in_one_collection_are_each_in_order(monkeypatch, store):
    _save([Document(page_content=MARKDOWN, metadata={})], {'file_id': 'f1'})
    _save([Document(page_content=MARKDOWN.replace('section', 'other'), metadata={})], {'file_id': 'f2'})
    by_file = {f: [i['text'] for i in store.items['kb1'] if i['metadata']['file_id'] == f] for f in ('f1', 'f2')}

    result = _read_back_shuffled(monkeypatch, store)
    read = result['documents'][0]

    for file_id, texts in by_file.items():
        assert [t for t, m in zip(read, result['metadatas'][0], strict=True) if m['file_id'] == file_id] == texts
    # Each file's chunks stay together.
    files = [m['file_id'] for m in result['metadatas'][0]]
    assert files == sorted(files, key=files.index)


def test_chunks_saved_before_the_numbering_keep_their_stored_order_after_numbered_ones():
    result = retrieval_utils.in_document_order(
        {
            'ids': [['x', 'b', 'y', 'a']],
            'documents': [['x', 'b', 'y', 'a']],
            'metadatas': [
                [
                    {'file_id': 'f'},
                    {'file_id': 'f', 'chunk_index': 1},
                    {'file_id': 'f'},
                    {'file_id': 'f', 'chunk_index': 0},
                ]
            ],
        }
    )

    assert result['documents'] == [['a', 'b', 'x', 'y']]


def test_an_empty_read_stays_empty():
    assert retrieval_utils.in_document_order({'ids': None, 'documents': None, 'metadatas': None})['documents'] is None


def test_a_file_added_to_a_knowledge_base_is_copied_in_its_order(monkeypatch):
    """The base's copies are numbered in the order they are passed on, so the file's must be."""
    import uuid

    from local_llm.internal.db import get_async_db
    from local_llm.models.files import FileForm, Files
    from local_llm.models.users import Users

    stored = [('c2', 'two', 2), ('c0', 'zero', 0), ('c1', 'one', 1)]
    saved: list[list[str]] = []

    async def query(collection_name, filter):
        return GetResult(
            ids=[[c[0] for c in stored]],
            documents=[[c[1] for c in stored]],
            metadatas=[[{'file_id': filter['file_id'], 'chunk_index': c[2]} for c in stored]],
        )

    async def config():
        return SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=False)

    def save(request, docs, **_kwargs):
        saved.append([d.page_content for d in docs])
        return True

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(retrieval_router.ASYNC_VECTOR_DB_CLIENT, 'query', query, raising=False)
    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', config)
    monkeypatch.setattr(retrieval_router, 'save_docs_to_vector_db', save)
    monkeypatch.setattr(retrieval_router, 'publish_event', nothing)

    async def scenario():
        tag = uuid.uuid4().hex[:8]
        owner = await Users.insert_new_user(f'o{tag}', 'Owner', f'o{tag}@example.invalid', role='user')
        file = await Files.insert_new_file(owner.id, FileForm(id=str(uuid.uuid4()), filename='n.md', path=''))
        async with get_async_db() as db:
            await retrieval_router.process_file_for(
                None,
                retrieval_router.ProcessFileForm(file_id=file.id, collection_name='kb1'),
                owner,
                db,
                check_collection_access=False,
            )

    asyncio.run(scenario())

    assert saved == [['zero', 'one', 'two']]
