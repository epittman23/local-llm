"""`POST /retrieval/config/update` with part of the web settings.

The Admin page sends every web field, but the endpoint also takes a `web`
block with only some of them. It used to write every field of that block
to the database, so a caller that sent two (turning SearXNG on) nulled the
other 72, SEARXNG_LANGUAGE among them, and every SearXNG search then failed
on `None.strip()`. These pin that only the fields sent are written, that a
full form still writes every field, and that SearXNG treats a null language
as its default.
"""

import asyncio
import typing
from types import SimpleNamespace

import pytest

from local_llm.retrieval.web import searxng
from local_llm.routers import retrieval

WEB_FIELDS = list(retrieval.WebConfig.model_fields)


@pytest.fixture
def stored(monkeypatch):
    """Every retrieval setting holds a distinct marker; returns what update_rag_config writes."""
    values = {field: f'stored:{field}' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
    written: dict = {}

    async def get_config():
        return retrieval.RetrievalConfig(dict(values))

    async def upsert(updates):
        written.update(updates)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_config)
    monkeypatch.setattr(retrieval.Config, 'upsert', upsert)
    return written


def _request():
    state = SimpleNamespace(YOUTUBE_LOADER_TRANSLATION='stored', rf=None, RERANKING_FUNCTION=None)
    return SimpleNamespace(app=SimpleNamespace(state=state))


def _update(form: retrieval.ConfigForm) -> SimpleNamespace:
    request = _request()
    asyncio.run(retrieval.update_rag_config(request, form, user=None))
    return request


def _marker(field: str, annotation):
    """A distinct value of the field's own type."""
    kinds = {a for a in typing.get_args(annotation) if a is not type(None)} or {annotation}
    kind = next(iter(kinds))
    origin = typing.get_origin(kind) or kind
    if origin is bool:
        return True
    if origin is int:
        return len(field)
    if origin is float:
        return len(field) / 10
    if origin is list:
        return [f'sent:{field}']
    if origin is dict:
        return {'sent': field}
    return f'sent:{field}'


def _web_keys(written: dict) -> dict:
    """The written values whose storage key belongs to a WebConfig field."""
    by_key = {retrieval.RETRIEVAL_CONFIG_KEYS[f]: f for f in WEB_FIELDS if f in retrieval.RETRIEVAL_CONFIG_KEYS}
    return {by_key[k]: v for k, v in written.items() if k in by_key}


def test_a_partial_web_block_writes_only_the_fields_sent(stored):
    web = retrieval.WebConfig(
        ENABLE_WEB_SEARCH=True, WEB_SEARCH_ENGINE='searxng', SEARXNG_QUERY_URL='http://127.0.0.1:8080/search?q=<query>'
    )
    _update(retrieval.ConfigForm(web=web))

    assert _web_keys(stored) == {
        'ENABLE_WEB_SEARCH': True,
        'WEB_SEARCH_ENGINE': 'searxng',
        'SEARXNG_QUERY_URL': 'http://127.0.0.1:8080/search?q=<query>',
    }
    assert None not in stored.values()


def test_a_field_sent_as_null_is_still_written(stored):
    # Clearing a setting on purpose (the Admin page sends null for an empty
    # optional field) must keep working.
    _update(retrieval.ConfigForm(web=retrieval.WebConfig(SEARXNG_LANGUAGE=None)))

    assert _web_keys(stored) == {'SEARXNG_LANGUAGE': None}


def test_a_full_web_block_writes_every_field(stored):
    # What the Admin page sends: every field, a distinct value for each.
    values = {field: _marker(field, info.annotation) for field, info in retrieval.WebConfig.model_fields.items()}
    request = _update(retrieval.ConfigForm(web=retrieval.WebConfig(**values)))

    stored_fields = {f for f in WEB_FIELDS if f in retrieval.RETRIEVAL_CONFIG_KEYS}
    assert _web_keys(stored) == {f: values[f] for f in stored_fields}
    assert request.app.state.YOUTUBE_LOADER_TRANSLATION == values['YOUTUBE_LOADER_TRANSLATION']


def test_brave_context_tokens_sent_as_null_keeps_the_stored_value(stored):
    _update(retrieval.ConfigForm(web=retrieval.WebConfig(BRAVE_SEARCH_CONTEXT_TOKENS=None, ENABLE_WEB_SEARCH=False)))

    assert _web_keys(stored) == {'ENABLE_WEB_SEARCH': False}


def test_searxng_treats_a_null_language_as_all(monkeypatch):
    seen = {}

    class Response:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def raise_for_status(self):
            pass

        async def json(self):
            return {'results': [{'url': 'https://example.org', 'title': 't', 'content': 'c', 'score': 1}]}

    class Session:
        def get(self, url, headers, params, ssl):
            seen['params'] = params
            return Response()

    async def get_session():
        return Session()

    monkeypatch.setattr(searxng, 'get_session', get_session)
    results = asyncio.run(searxng.search_searxng('http://127.0.0.1:8080/search?q=<query>', 'q', 5, language=None))

    assert seen['params']['language'] == 'all'
    assert [r.link for r in results] == ['https://example.org']
