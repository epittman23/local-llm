"""The direct API path keeps the status a failure carries (#364).

A chat completion without chat/message ids has no socket to report an error
on, so `main._process_chat` raises it as an HTTP error. The provider's status
(429, 401, 503, ...) and the router's own HTTPException status (404, 502, ...)
must reach the client; only a failure with no status is a 400.

Run from apps/server:

    python -m pytest tests/test_direct_api_error_status.py
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from local_llm import main


def _run(monkeypatch, *, response=None, payload_raise=None, metadata=None):
    async def process_chat_payload(request, form_data, user, metadata, model):
        if payload_raise is not None:
            raise payload_raise
        return form_data, metadata, []

    async def no(*args, **kwargs):
        return False

    async def nothing(*args, **kwargs):
        return None

    async def chat_completion_handler(request, form_data, user):
        return response

    monkeypatch.setattr(main, 'process_chat_payload', process_chat_payload)
    monkeypatch.setattr(main, 'drain_approved_tool_calls', no)
    monkeypatch.setattr(main, 'chat_completion_handler', chat_completion_handler)
    monkeypatch.setattr(main, '_disconnect_mcp_clients', nothing)
    monkeypatch.setattr(main, '_end_chat_task', nothing)
    monkeypatch.setattr(main, '_run_pending_internal_messages', nothing)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(main._process_chat(None, {}, None, metadata or {}, {}))
    return raised.value


@pytest.mark.parametrize('status', [401, 429, 503])
def test_an_upstream_status_is_kept(monkeypatch, status):
    response = JSONResponse(status_code=status, content={'error': {'message': 'upstream said no'}})
    error = _run(monkeypatch, response=response)
    assert (error.status_code, error.detail) == (status, 'upstream said no')


def test_a_router_http_error_keeps_its_status(monkeypatch):
    error = _run(monkeypatch, payload_raise=HTTPException(status_code=404, detail='Model not found'))
    assert (error.status_code, error.detail) == (404, 'Model not found')


def test_a_gateway_error_keeps_its_status(monkeypatch):
    error = _run(monkeypatch, payload_raise=HTTPException(status_code=504, detail='timed out'))
    assert error.status_code == 504


def test_a_bad_request_stays_400(monkeypatch):
    response = JSONResponse(status_code=400, content={'error': {'message': 'content filtered'}})
    error = _run(monkeypatch, response=response)
    assert (error.status_code, error.detail) == (400, 'content filtered')


def test_a_failure_without_a_status_is_a_400(monkeypatch):
    error = _run(monkeypatch, payload_raise=RuntimeError('boom'))
    assert (error.status_code, error.detail) == (400, 'boom')
