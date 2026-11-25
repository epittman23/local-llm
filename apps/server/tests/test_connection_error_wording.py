"""A model or speech server that can't be reached is said in plain words, with where to fix it (#1124, FBK-4).

These are the paths that used to answer 'Local LLM: Server Connection Error'. The HTTP sessions and the
settings are fakes: no socket is opened.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from fastapi import HTTPException

from local_llm.constants import ERROR_MESSAGES
from local_llm.routers import audio, openai

MODEL = "Couldn't reach the model server. Check its connection in Admin > Settings > Connections."
SPEECH = "Couldn't reach the speech server. Check it in Admin > Settings > Audio."


def test_the_messages_name_no_product_and_say_where_to_look() -> None:
    assert ERROR_MESSAGES.SERVER_CONNECTION_ERROR == MODEL
    assert ERROR_MESSAGES.AUDIO_SERVER_CONNECTION_ERROR == SPEECH


class RefusingSession:
    """An aiohttp session whose every request fails before any answer."""

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def post(self, *args, **kwargs):
        raise aiohttp.ClientConnectionError('refused')

    def get(self, *args, **kwargs):
        raise aiohttp.ClientConnectionError('refused')


@pytest.fixture
def speech_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    async def get(key: str):
        return {'audio.stt.openai.api_request_format': 'json'}.get(key, 'x')

    async def session() -> RefusingSession:
        return RefusingSession()

    monkeypatch.setattr(audio.Config, 'get', get)
    monkeypatch.setattr(audio, 'get_session', session)


def test_a_failed_speech_synthesis_says_the_speech_server(speech_settings: None) -> None:
    with pytest.raises(HTTPException) as caught:
        asyncio.run(audio._raise_tts_error(RuntimeError('refused')))
    assert (caught.value.status_code, caught.value.detail) == (500, SPEECH)


@pytest.mark.parametrize('transcribe', ['openai', 'deepgram'])
def test_a_failed_transcription_says_the_speech_server(speech_settings: None, tmp_path: Path, transcribe: str) -> None:
    clip = tmp_path / 'clip.wav'
    clip.write_bytes(b'RIFF')
    if transcribe == 'openai':
        call = audio._transcribe_openai(SimpleNamespace(), str(clip), 'clip.wav', [None], str(tmp_path), 'id')
    else:
        call = audio._transcribe_deepgram(SimpleNamespace(), str(clip), [None], str(tmp_path), 'id')
    with pytest.raises(Exception, match=r"^Couldn't reach the speech server\.") as caught:
        asyncio.run(call)
    assert str(caught.value) == SPEECH


def test_a_model_list_that_cannot_be_fetched_says_the_model_server(monkeypatch: pytest.MonkeyPatch) -> None:
    async def get(key: str):
        return True

    async def connection(idx: int):
        return 'http://127.0.0.1:9/v1', 'sk-test', {}

    async def headers_and_cookies(*args, **kwargs):
        return {}, {}

    monkeypatch.setattr(openai.Config, 'get', get)
    monkeypatch.setattr(openai, 'get_openai_connection', connection)
    monkeypatch.setattr(openai, 'get_headers_and_cookies', headers_and_cookies)
    monkeypatch.setattr(openai.aiohttp, 'ClientSession', RefusingSession)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(openai.get_models(SimpleNamespace(), url_idx=0, user=SimpleNamespace(id='u')))
    assert (caught.value.status_code, caught.value.detail) == (500, MODEL)
