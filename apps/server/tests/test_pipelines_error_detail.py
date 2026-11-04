"""A Pipelines server's error detail reaches the client, and only an update announces new valves (#304).

Every route read the server's reply only after the `async with` had released
it, so the body was gone and every failure came out as "Pipeline not found",
or a bare reason phrase from a filter. And `PIPELINE_VALVES_UPDATED` was
published when valves were read, not when they were updated.

Run from apps/server:

    python -m pytest tests/test_pipelines_error_detail.py
"""

from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

import pytest
from aiohttp import web
from fastapi import HTTPException, UploadFile

from local_llm.routers import pipelines as pipelines_router

RATE_LIMITED = 'Rate limit exceeded: 10 requests per minute'
ADMIN = SimpleNamespace(id='a', email='a@example.invalid', name='A', role='admin')
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))


def _filters(pipeline_id: str = 'limit') -> dict:
    return {
        'gpt': {'id': 'gpt'},
        pipeline_id: {
            'id': pipeline_id,
            'urlIdx': 0,
            'pipeline': {'type': 'filter', 'pipelines': ['*'], 'priority': 0},
        },
    }


async def _reject(_request):
    return web.json_response({'detail': RATE_LIMITED}, status=429)


async def _reject_plainly(_request):
    return web.Response(text='nope', status=503)


async def _valves(_request):
    return web.json_response({'max_tokens': 5})


def _against_server(monkeypatch, call):
    """Runs `call()` against a local stand-in for a Pipelines server; gives its result and the events published."""
    published: list[str] = []

    async def publish(_request, event, **_kwargs):
        published.append(event.name)

    async def go():
        app = web.Application()
        for path in ('/limit/valves/update', '/limit/valves', '/limit/valves/spec', '/limit/filter/inlet',
                     '/limit/filter/outlet', '/pipelines/add', '/pipelines/delete', '/pipelines',
                     '/pipelines/upload'):  # fmt: skip
            app.router.add_route('*', path, _reject)
        app.router.add_route('*', '/plain/filter/inlet', _reject_plainly)
        app.router.add_get('/ok/valves', _valves)
        app.router.add_post('/ok/valves/update', _valves)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]

        async def connection(_idx):
            return f'http://127.0.0.1:{port}', 'key'

        monkeypatch.setattr(pipelines_router, 'get_openai_connection', connection)
        monkeypatch.setattr(pipelines_router, 'publish_event', publish)
        try:
            return await call()
        finally:
            await runner.cleanup()

    return asyncio.run(go()), published


def _rejection(call):
    async def expect():
        with pytest.raises(HTTPException) as raised:
            await call()
        return raised.value

    return expect


def _upload():
    return pipelines_router.upload_pipeline(
        REQUEST, 0, UploadFile(file=io.BytesIO(b'class Pipeline: ...\n'), filename='limit.py'), user=ADMIN
    )


ADMIN_CALLS = [
    lambda: pipelines_router.update_pipeline_valves(REQUEST, 0, 'limit', {'requests_per_minute': 10}, user=ADMIN),
    lambda: pipelines_router.get_pipeline_valves(REQUEST, 0, 'limit', user=ADMIN),
    lambda: pipelines_router.get_pipeline_valves_spec(REQUEST, 0, 'limit', user=ADMIN),
    lambda: pipelines_router.add_pipeline(REQUEST, pipelines_router.AddPipelineForm(url='x', urlIdx=0), user=ADMIN),
    lambda: pipelines_router.delete_pipeline(
        REQUEST, pipelines_router.DeletePipelineForm(id='limit', urlIdx=0), user=ADMIN
    ),
    lambda: pipelines_router.get_pipelines(REQUEST, 0, user=ADMIN),
    _upload,
]
ADMIN_IDS = ['update valves', 'valves', 'valves spec', 'add', 'delete', 'list', 'upload']


@pytest.mark.parametrize('call', ADMIN_CALLS, ids=ADMIN_IDS)
def test_a_server_that_cannot_be_reached_is_still_reported_as_not_found(monkeypatch, call):
    async def unreachable(_idx):
        return 'http://127.0.0.1:1', 'key'

    async def go():
        monkeypatch.setattr(pipelines_router, 'get_openai_connection', unreachable)
        return await _rejection(call)()

    error = asyncio.run(go())

    assert (error.status_code, error.detail) == (404, 'Pipeline not found')


@pytest.mark.parametrize(
    'call',
    [
        *ADMIN_CALLS,
        lambda: pipelines_router.process_pipeline_inlet_filter(REQUEST, {'model': 'gpt'}, ADMIN, _filters()),
        lambda: pipelines_router.process_pipeline_outlet_filter(REQUEST, {'model': 'gpt'}, ADMIN, _filters()),
    ],
    ids=[*ADMIN_IDS, 'inlet filter', 'outlet filter'],
)
def test_the_servers_error_detail_reaches_the_client(monkeypatch, call):
    error, published = _against_server(monkeypatch, _rejection(call))

    assert (error.status_code, error.detail) == (429, RATE_LIMITED)
    assert published == []


def test_a_filter_without_a_detail_still_gives_its_status_and_reason(monkeypatch):
    def call():
        return pipelines_router.process_pipeline_inlet_filter(REQUEST, {'model': 'gpt'}, ADMIN, _filters('plain'))

    error, _ = _against_server(monkeypatch, _rejection(call))

    assert (error.status_code, error.detail) == (503, 'Service Unavailable')


def test_reading_valves_announces_nothing_and_updating_them_does(monkeypatch):
    read, on_read = _against_server(
        monkeypatch, lambda: pipelines_router.get_pipeline_valves(REQUEST, 0, 'ok', user=ADMIN)
    )
    updated, on_update = _against_server(
        monkeypatch, lambda: pipelines_router.update_pipeline_valves(REQUEST, 0, 'ok', {'max_tokens': 5}, user=ADMIN)
    )

    assert read == updated == {'max_tokens': 5}
    assert on_read == []
    assert on_update == [pipelines_router.EVENTS.PIPELINE_VALVES_UPDATED.name]
