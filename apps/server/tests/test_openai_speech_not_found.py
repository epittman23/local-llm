"""/openai/audio/speech without an api.openai.com connection is a clear 404, not a 500 (#300).

The route answers that case with ERROR_MESSAGES.OPENAI_NOT_FOUND, but passed
the function itself as the detail instead of calling it, so the response
could not be serialised and every such call was a 500. It also answered 401,
which tells a client its credentials were refused. It is now a 404 with the
message.

Run from apps/server:

    python -m pytest tests/test_openai_speech_not_found.py
"""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.routers import openai
from local_llm.utils.auth import get_verified_user


def test_speech_without_an_openai_connection_is_a_404_with_the_message(monkeypatch):
    async def runtime_config():
        return True, ['http://localhost:8090/v1'], [''], {}

    monkeypatch.setattr(openai, 'get_openai_runtime_config', runtime_config)
    app = FastAPI()
    app.include_router(openai.router, prefix='/openai')
    app.dependency_overrides[get_verified_user] = lambda: SimpleNamespace(id='admin', role='admin')

    r = TestClient(app, raise_server_exceptions=False).post('/openai/audio/speech', json={'input': 'hi'})

    assert r.status_code == 404
    assert r.json() == {'detail': 'OpenAI API was not found'}
