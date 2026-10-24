"""Every outbound `requests` call in retrieval carries a timeout (ruff S113).

requests waits forever by default, so a search API, document converter or
embedding server that accepts the connection and never answers would hold
its worker thread for good. Each call site passes one of env.py's
REQUESTS_TIMEOUT_* (connect, read) pairs, chosen by how long the service
can legitimately take before it answers. requests is replaced by a fake that
records the timeout and fails the call, so nothing here touches the network.

Run from apps/server:

    python -m pytest tests/test_requests_timeouts.py
"""

from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest
import requests

from local_llm.env import REQUESTS_TIMEOUT_API, REQUESTS_TIMEOUT_PROCESSING, REQUESTS_TIMEOUT_SLOW_API
from local_llm.retrieval import utils as retrieval_utils
from local_llm.retrieval.loaders import datalab_marker, external_document, external_web, paddleocr_vl, tavily
from local_llm.retrieval.loaders import main as loaders_main
from local_llm.retrieval.web import (
    bing,
    brave_llm_context,
    exa,
    external,
    jina_search,
    kagi,
    microsoft_web_iq,
    mojeek,
    ollama,
    perplexity,
    perplexity_search,
    searchapi,
    serpapi,
    serply,
    yacy,
    yandex,
    ydc,
)
from local_llm.retrieval.web import tavily as tavily_search


class _Stop(Exception):
    """Raised by the fake in place of a response."""


@pytest.fixture
def timeouts(monkeypatch) -> list:
    seen = []

    def fake(*_args, **kwargs):
        seen.append(kwargs.get('timeout'))
        raise _Stop

    for name in ('get', 'post', 'put', 'request'):
        monkeypatch.setattr(requests, name, fake)
    return seen


@pytest.fixture
def document(tmp_path) -> str:
    path = tmp_path / 'doc.pdf'
    path.write_bytes(b'%PDF-1.4 not really')
    return str(path)


REQUEST = SimpleNamespace(state=SimpleNamespace())

SEARCHES = {
    'bing': lambda: bing.search_bing('key', 'https://bing.invalid', 'en-US', 'q', 3),
    'brave llm context': lambda: brave_llm_context.search_brave_llm_context('key', 'q', 3),
    'exa': lambda: exa.search_exa('key', 'q', 3),
    'jina': lambda: jina_search.search_jina('key', 'q', 3),
    'kagi': lambda: kagi.search_kagi('key', 'q', 3),
    'microsoft web iq': lambda: microsoft_web_iq.search_microsoft_web_iq('https://iq.invalid', 'key', 'q', 3),
    'mojeek': lambda: mojeek.search_mojeek('key', 'q', 3),
    'ollama': lambda: ollama.search_ollama_cloud('https://ollama.invalid', 'key', 'q', 3),
    'perplexity search': lambda: perplexity_search.search_perplexity_search('key', 'q', 3),
    'searchapi': lambda: searchapi.search_searchapi('key', 'google', 'q', 3),
    'serpapi': lambda: serpapi.search_serpapi('key', 'google', 'q', 3),
    'serply': lambda: serply.search_serply('key', 'q', 3),
    'tavily': lambda: tavily_search.search_tavily('key', 'q', 3),
    'yacy': lambda: yacy.search_yacy('https://yacy.invalid', None, None, 'q', 3),
    'yandex': lambda: yandex.search_yandex(REQUEST, '', 'key', '', 'q', 3),
    'you.com': lambda: ydc.search_youcom('key', 'q', 3),
}

SLOW_APIS = {
    'perplexity answer': lambda: perplexity.search_perplexity('key', 'q', 3),
    'external search': lambda: external.search_external(REQUEST, 'https://search.invalid', 'key', 'q', 3),
    'external web loader': lambda: list(
        external_web.ExternalWebLoader('https://a.invalid', 'https://x.invalid', 'k').lazy_load()
    ),
    'tavily extract': lambda: list(tavily.TavilyLoader('https://a.invalid', 'key').lazy_load()),
}

EMBEDDINGS = {
    'openai': lambda: retrieval_utils.generate_openai_batch_embeddings('m', ['t'], 'https://o.invalid'),
    'azure openai': lambda: retrieval_utils.generate_azure_openai_batch_embeddings('m', ['t'], 'https://a.invalid'),
    'ollama': lambda: retrieval_utils.generate_ollama_batch_embeddings('m', ['t'], 'https://o.invalid'),
}


def _call(fn) -> None:
    with contextlib.suppress(Exception):
        fn()


@pytest.mark.parametrize('name', SEARCHES)
def test_search_apis_time_out(timeouts, name):
    _call(SEARCHES[name])
    assert timeouts and set(timeouts) == {REQUESTS_TIMEOUT_API}


@pytest.mark.parametrize('name', SLOW_APIS)
def test_slow_apis_get_longer(timeouts, name):
    _call(SLOW_APIS[name])
    assert timeouts and set(timeouts) == {REQUESTS_TIMEOUT_SLOW_API}


@pytest.mark.parametrize('name', EMBEDDINGS)
def test_embedding_calls_time_out(timeouts, name):
    _call(EMBEDDINGS[name])
    assert timeouts and set(timeouts) == {REQUESTS_TIMEOUT_PROCESSING}


@pytest.mark.parametrize(
    'make',
    [
        lambda path: external_document.ExternalDocumentLoader(path, 'https://convert.invalid', 'key'),
        lambda path: loaders_main.TikaLoader('https://tika.invalid', path, 'application/pdf'),
        lambda path: loaders_main.DoclingLoader('https://docling.invalid', file_path=path, mime_type='application/pdf'),
        lambda path: paddleocr_vl.PaddleOCRVLLoader('https://ocr.invalid', 'token', path),
    ],
    ids=['external document', 'tika', 'docling', 'paddleocr'],
)
def test_document_conversion_gets_the_processing_timeout(timeouts, document, make):
    _call(make(document).load)
    assert timeouts and set(timeouts) == {REQUESTS_TIMEOUT_PROCESSING}


def test_datalab_converts_with_the_processing_timeout_and_polls_with_the_api_one(monkeypatch, document):
    seen = []

    def post(*_args, **kwargs):
        seen.append(('post', kwargs['timeout']))
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {'success': True, 'request_check_url': 'https://datalab.invalid/check'},
        )

    def get(*_args, **kwargs):
        seen.append(('get', kwargs['timeout']))
        raise _Stop

    monkeypatch.setattr(requests, 'post', post)
    monkeypatch.setattr(requests, 'get', get)
    monkeypatch.setattr(datalab_marker.time, 'sleep', lambda _s: None)

    with pytest.raises(_Stop):
        datalab_marker.DatalabMarkerLoader(document, 'key', 'https://datalab.invalid').load()

    assert seen == [('post', REQUESTS_TIMEOUT_PROCESSING), ('get', REQUESTS_TIMEOUT_API)]


def test_the_timeouts_are_connect_and_read_pairs():
    for timeout in (REQUESTS_TIMEOUT_API, REQUESTS_TIMEOUT_SLOW_API, REQUESTS_TIMEOUT_PROCESSING):
        connect, read = timeout
        assert 0 < connect <= read
    assert REQUESTS_TIMEOUT_API[1] < REQUESTS_TIMEOUT_SLOW_API[1] < REQUESTS_TIMEOUT_PROCESSING[1]


def test_the_brave_retry_after_a_rate_limit_also_times_out(monkeypatch):
    seen = []

    def get(*_args, **kwargs):
        seen.append(kwargs['timeout'])
        if len(seen) == 1:
            return SimpleNamespace(status_code=429)
        raise _Stop

    monkeypatch.setattr(requests, 'get', get)
    monkeypatch.setattr(brave_llm_context.time, 'sleep', lambda _s: None)

    with pytest.raises(_Stop):
        brave_llm_context.search_brave_llm_context('key', 'q', 3)

    assert seen == [REQUESTS_TIMEOUT_API, REQUESTS_TIMEOUT_API]
