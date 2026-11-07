"""The cap on a document's metadata values follows the upload size limit an admin sets (#629).

The cap fell back to the RAG_FILE_MAX_SIZE environment variable, read once at
startup, so the limit set in Admin Settings > Documents (`rag.file.max_size`)
never reached it, and with the variable unset metadata values were not capped
at all. The cap is now worked out at use time from the retrieval config the
caller has just read; RAG_METADATA_MAX_VALUE_CHARS still wins when set.

Run from apps/server:

    python -m pytest tests/test_metadata_cap_follows_upload_limit.py
"""

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.documents import Document

from local_llm.retrieval.vector import utils as vector_utils
from local_llm.routers import retrieval as retrieval_router

MIB = 1024 * 1024
# A list whose text is about 1.5 MiB: over a 1 MB limit, under a 2 MB one.
BIG = ['x' * 1000] * 1500


class Store:
    def __init__(self):
        self.items: list[dict] = []

    def has_collection(self, collection_name):
        return False

    def insert(self, collection_name, items):
        self.items.extend(items)


@pytest.fixture
def store(monkeypatch):
    store = Store()
    monkeypatch.setattr(retrieval_router, 'VECTOR_DB_CLIENT', store)
    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', None)

    def embedding_function(*_args, **_kwargs):
        async def embed(texts, prefix=None, user=None):
            return [[0.0] for _ in texts]

        return embed

    monkeypatch.setattr(retrieval_router, 'get_embedding_function', embedding_function)
    return store


def _save(file_max_size, split=False, docs=None, **settings):
    config = retrieval_router.RetrievalConfig(
        {
            **settings,
            'FILE_MAX_SIZE': file_max_size,
            'RAG_EMBEDDING_ENGINE': '',
            'RAG_EMBEDDING_MODEL': 'm',
            'RAG_EMBEDDING_BATCH_SIZE': 1,
            'ENABLE_ASYNC_EMBEDDING': True,
            'RAG_EMBEDDING_CONCURRENT_REQUESTS': 0,
            'RAG_AZURE_OPENAI_BASE_URL': '',
            'RAG_AZURE_OPENAI_API_KEY': '',
            'RAG_AZURE_OPENAI_API_VERSION': '',
        }
    )
    docs = docs or [Document(page_content='text', metadata={'source': 'a.zip', 'entries': BIG})]

    async def run():
        request: Any = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(ef=None, main_loop=asyncio.get_running_loop()))
        )
        return await asyncio.to_thread(
            retrieval_router.save_docs_to_vector_db,
            request,
            docs=docs,
            collection_name='file-1',
            config=config,
            split=split,
        )

    return asyncio.run(run())


def test_the_admin_upload_limit_caps_saved_metadata(store):
    assert _save(1) is True

    (item,) = store.items
    assert 'entries' not in item['metadata']
    assert item['metadata']['source'] == 'a.zip'


def test_raising_the_admin_upload_limit_raises_the_cap(store):
    assert _save(2) is True

    assert store.items[0]['metadata']['entries'] == BIG


@pytest.mark.parametrize(
    ('file_max_size', 'cap'),
    [(1, MIB), ('3', 3 * MIB), (None, None), ('', None), (0, None), ('ten', None), (-1, None), ('-2', None)],
)
def test_the_cap_is_the_upload_limit_in_characters(monkeypatch, file_max_size, cap):
    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', None)

    assert vector_utils.metadata_max_value_chars(file_max_size) == cap


@pytest.mark.parametrize('setting', [0, 500])
def test_its_own_setting_wins_over_the_upload_limit(monkeypatch, setting):
    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', setting)

    assert vector_utils.metadata_max_value_chars(2) == setting


def test_filter_metadata_drops_values_over_the_cap_it_is_given():
    metadata = {'source': 'a.zip', 'entries': BIG, 'content': 'excluded'}

    assert vector_utils.filter_metadata(metadata, max_value_chars=MIB) == {'source': 'a.zip'}
    assert vector_utils.filter_metadata(metadata, max_value_chars=2 * MIB) == {'source': 'a.zip', 'entries': BIG}
    assert vector_utils.filter_metadata(metadata, max_value_chars=None) == {'source': 'a.zip', 'entries': BIG}


@pytest.mark.parametrize(('file_max_size', 'kept'), [(1, False), (2, True)])
def test_a_processed_files_loader_metadata_follows_the_admin_limit(monkeypatch, file_max_size, kept):
    import uuid

    from local_llm.internal.db import get_async_db
    from local_llm.models.files import FileForm, Files
    from local_llm.models.users import Users

    saved: list[list[Document]] = []

    async def config():
        return SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=False, FILE_MAX_SIZE=file_max_size)

    async def loader_config():
        return {}

    class Loader:
        async def aload(self, filename, content_type, file_path):
            return [Document(page_content='text', metadata={'page': 1, 'entries': BIG})]

    def save(request, docs, **_kwargs):
        saved.append(docs)
        return True

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', None)
    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', config)
    monkeypatch.setattr(retrieval_router, 'get_loader_config', loader_config)
    monkeypatch.setattr(retrieval_router, 'build_loader_from_config', lambda request, cfg: Loader())
    monkeypatch.setattr(retrieval_router.Storage, 'get_file', lambda path: path)
    monkeypatch.setattr(retrieval_router, 'save_docs_to_vector_db', save)
    monkeypatch.setattr(retrieval_router, 'publish_event', nothing)

    async def scenario():
        tag = uuid.uuid4().hex[:8]
        owner = await Users.insert_new_user(f'o{tag}', 'Owner', f'o{tag}@example.invalid', role='user')
        assert owner is not None
        file = await Files.insert_new_file(
            owner.id, FileForm(id=str(uuid.uuid4()), filename='a.zip', path='/uploads/a.zip')
        )
        assert file is not None
        request: Any = None
        async with get_async_db() as db:
            await retrieval_router.process_file_for(
                request, retrieval_router.ProcessFileForm(file_id=file.id), owner, db, check_collection_access=False
            )

    asyncio.run(scenario())

    ((doc,),) = saved
    assert doc.metadata['page'] == 1
    assert ('entries' in doc.metadata) is kept


def test_the_cap_is_applied_before_splitting(store, monkeypatch):
    # The splitter copies each document's metadata into every chunk, so an oversized
    # value must be gone before it runs, not after.
    seen: list[dict] = []
    splitter = retrieval_router.RecursiveCharacterTextSplitter

    class Recording(splitter):
        def split_documents(self, documents):
            seen.extend(doc.metadata for doc in documents)
            return super().split_documents(documents)

    monkeypatch.setattr(retrieval_router, 'RecursiveCharacterTextSplitter', Recording)
    docs = [Document(page_content='word ' * 400, metadata={'source': 'a.zip', 'entries': BIG})]

    assert _save(
        1,
        split=True,
        docs=docs,
        TEXT_SPLITTER='character',
        CHUNK_SIZE=100,
        CHUNK_OVERLAP=0,
        ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER=False,
        CHUNK_MIN_SIZE_TARGET=0,
    )

    assert seen == [{'source': 'a.zip'}]
    assert len(store.items) > 1
    assert all('entries' not in item['metadata'] for item in store.items)
    # The caller's documents are left as they were: a caller may save them again elsewhere.
    assert docs[0].metadata['entries'] is BIG


def test_process_metadata_applies_only_its_own_setting(monkeypatch):
    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', None)
    assert 'entries' in vector_utils.process_metadata({'entries': BIG})

    monkeypatch.setattr(vector_utils, 'RAG_METADATA_MAX_VALUE_CHARS', 10)
    assert vector_utils.process_metadata({'entries': BIG, 'tags': ['a'], 'n': 1}) == {'tags': "['a']", 'n': 1}


def test_a_value_that_cannot_be_measured_is_dropped():
    class Unprintable:
        def __repr__(self):
            raise ValueError('no text')

    metadata = {'source': 'a.zip', 'entries': [Unprintable()]}

    assert vector_utils.drop_oversized_values(metadata, 10) == {'source': 'a.zip'}
