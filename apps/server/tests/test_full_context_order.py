"""A full-context read returns each file's chunks in document order (#355).

Vector stores return a collection in no set order (pgvector has no ORDER BY,
and its ids are random UUIDs), so after deletes and a VACUUM a file's chunks
could come back shuffled, and the model read the document garbled. The
chunks of each file are now sorted by `start_index`.

Run from apps/server:

    python -m pytest tests/test_full_context_order.py
"""

from local_llm.retrieval import utils as retrieval_utils
from local_llm.retrieval.vector.main import GetResult


def _chunk(file_id, start, text):
    metadata = {'file_id': file_id, 'start_index': start} if start is not None else {'file_id': file_id}
    return (f'id-{text}', text, metadata)


def _stored(monkeypatch, collections):
    def get_doc(collection_name, user=None):
        chunks = collections[collection_name]
        return GetResult(
            ids=[[c[0] for c in chunks]],
            documents=[[c[1] for c in chunks]],
            metadatas=[[c[2] for c in chunks]],
        )

    monkeypatch.setattr(retrieval_utils, 'get_doc', get_doc)


def test_each_files_chunks_come_back_in_document_order(monkeypatch):
    _stored(
        monkeypatch,
        {
            'kb1': [
                _chunk('b', 900, 'b3'),
                _chunk('a', 500, 'a2'),
                _chunk('b', 0, 'b1'),
                _chunk('a', 0, 'a1'),
                _chunk('b', 450, 'b2'),
                _chunk('a', 1000, 'a3'),
            ]
        },
    )

    result = retrieval_utils.get_all_items_from_collections(['kb1'])

    # Files keep the order they first appear in; each file's chunks are sorted.
    assert result['documents'] == [['b1', 'b2', 'b3', 'a1', 'a2', 'a3']]
    assert result['ids'] == [['id-b1', 'id-b2', 'id-b3', 'id-a1', 'id-a2', 'id-a3']]
    assert [m['start_index'] for m in result['metadatas'][0]] == [0, 450, 900, 0, 500, 1000]


def test_chunks_without_a_start_index_keep_their_place_after_the_others(monkeypatch):
    _stored(
        monkeypatch,
        {'kb1': [_chunk('a', None, 'x'), _chunk('a', 10, 'a2'), _chunk('a', None, 'y'), _chunk('a', 0, 'a1')]},
    )

    assert retrieval_utils.get_all_items_from_collections(['kb1'])['documents'] == [['a1', 'a2', 'x', 'y']]


def test_collections_stay_in_the_order_asked(monkeypatch):
    _stored(monkeypatch, {'kb2': [_chunk('z', 5, 'z2'), _chunk('z', 0, 'z1')], 'kb1': [_chunk('a', 0, 'a1')]})

    assert retrieval_utils.get_all_items_from_collections(['kb2', 'kb1'])['documents'] == [['z1', 'z2', 'a1']]


def test_an_empty_collection_reads_as_empty(monkeypatch):
    _stored(monkeypatch, {'kb1': []})

    assert retrieval_utils.get_all_items_from_collections(['kb1'])['documents'] == [[]]
