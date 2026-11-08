"""The chat says which knowledge sources failed, after `sources_retrieved` (#528).

Partial failure (the rest were used) and total failure (every source failed;
the reply goes on without them) get separate messages. Labels only: the raw
error of an external base can carry connection details.

Run from apps/server:

    python -m pytest tests/test_chat_source_failure_status.py
"""

import asyncio

from local_llm.utils import middleware

SECRET = 'postgres://admin:hunter2@db.internal'
BODY = {'model': 'm', 'messages': [], 'metadata': {'files': [{'type': 'collection', 'id': 'kb', 'context': 'full'}]}}
SOURCE = {'source': {'id': 's'}, 'document': ['text'], 'metadata': [{'source': 's'}]}


def _handle(monkeypatch, labels, sources):
    async def config_get_many(*keys):
        return {}

    async def get_sources(**kwargs):
        kwargs['failures'].extend(labels)
        if not sources:
            raise RuntimeError(f'Sources unavailable: {SECRET}')
        return sources

    monkeypatch.setattr(middleware.Config, 'get_many', config_get_many)
    monkeypatch.setattr(middleware, 'get_sources_from_items', get_sources)
    request = type('R', (), {'app': type('A', (), {'state': type('S', (), {'RERANKING_FUNCTION': None})()})()})()
    events = []

    async def emit(event):
        events.append(event['data'])

    body = {**BODY, 'metadata': {'files': list(BODY['metadata']['files'])}}
    _, result = asyncio.run(middleware.chat_completion_files_handler(request, body, {'__event_emitter__': emit}, None))
    return events, result


def test_partial_failure_names_the_failed_items_and_the_rest_are_used(monkeypatch):
    events, result = _handle(monkeypatch, ['Taxes', 'external knowledge base'], [SOURCE])

    assert [e['action'] for e in events] == ['sources_retrieved', 'sources_failed']
    assert events[1]['description'] == (
        'Could not search: Taxes, external knowledge base. Answering from the other sources.'
    )
    assert events[1]['failed'] == ['Taxes', 'external knowledge base']
    assert result == {'sources': [SOURCE]}


def test_total_failure_has_its_own_message_and_the_reply_continues(monkeypatch):
    events, result = _handle(monkeypatch, ['external knowledge base'], [])

    assert [e['action'] for e in events] == ['sources_retrieved', 'sources_failed']
    assert events[1]['description'] == 'Could not search any source (external knowledge base). Answering without them.'
    assert result == {'sources': []}


def test_no_status_when_nothing_fails(monkeypatch):
    events, _ = _handle(monkeypatch, [], [SOURCE])

    assert [e['action'] for e in events] == ['sources_retrieved']


def test_the_raw_error_never_appears_in_a_status(monkeypatch):
    for sources in ([SOURCE], []):
        events, _ = _handle(monkeypatch, ['external knowledge base'], sources)
        assert 'hunter2' not in str(events)
        assert 'db.internal' not in str(events)
