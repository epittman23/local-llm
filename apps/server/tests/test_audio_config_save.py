"""Saving Admin Settings > Audio loads the local Whisper model only when it changes (#342).

`update_audio_config` saved the settings and then, whenever speech to text
used the local engine, loaded the Whisper model again: on every save, a
voice change included. Under `make backend`'s `HF_HUB_OFFLINE=1`, with the
model not in the cache, that load raised after the settings were saved, so
every save answered 500 although it had stored them.

Now the model is loaded only when the local engine is chosen or its model
changes, and before anything is saved: a model that cannot load refuses the
save with a JSON error naming it, and nothing is stored. A model that is not
loaded yet and does not change is left to load when it is first used, as
transcription already does.

The route runs for real against the test database's config; the model loader
and the event publisher are faked.

Run from apps/server:

    python -m pytest tests/test_audio_config_save.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models.config import Config
from local_llm.routers import audio as audio_router

ADMIN = SimpleNamespace(id='admin', role='admin')


@pytest.fixture
def harness(monkeypatch):
    loads: list[str] = []
    state = SimpleNamespace(fail=set())

    def load(model, auto_update=False):
        loads.append(model)
        if model in state.fail:
            raise RuntimeError(f'LocalEntryNotFoundError: {model} is not in the cache')
        return f'loaded:{model}'

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(audio_router, 'set_faster_whisper_model', load)
    monkeypatch.setattr(audio_router, 'publish_event', nothing)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(faster_whisper_model=None)))
    return SimpleNamespace(request=request, loads=loads, state=state)


def _form(voice='alloy', engine='', whisper='base', load=False):
    config = asyncio.run(audio_router.get_audio_config(None, ADMIN))
    tts = {**{field: '' for field in audio_router.TTSConfigForm.model_fields}, **config['tts'], 'VOICE': voice}
    stt = {
        **{field: '' for field in audio_router.STTConfigForm.model_fields},
        'SUPPORTED_CONTENT_TYPES': [],
        'ALLOWED_EXTENSIONS': [],
        'MISTRAL_USE_CHAT_COMPLETIONS': False,
        **config['stt'],
        'ENGINE': engine,
        'WHISPER_MODEL': whisper,
    }
    return audio_router.AudioConfigUpdateForm.model_validate({'tts': tts, 'stt': stt, 'LOAD_WHISPER_MODEL': load})


def _save(harness, form):
    return asyncio.run(audio_router.update_audio_config(harness.request, form, ADMIN))


def _stored(key):
    return asyncio.run(Config.get(key))


@pytest.fixture(autouse=True)
def local_whisper_base(harness):
    """Each test starts from the local engine with the `base` model saved."""
    _save(harness, _form(voice='start', engine='', whisper='base'))
    harness.loads.clear()
    harness.request.app.state.faster_whisper_model = None


def test_a_tts_only_change_does_not_load_the_model(harness):
    harness.state.fail.add('base')

    _save(harness, _form(voice='nova'))

    assert harness.loads == []
    assert _stored('audio.tts.voice') == 'nova'


def test_the_update_model_button_loads_an_unchanged_model(harness):
    _save(harness, _form(load=True))

    assert harness.loads == ['base']
    assert harness.request.app.state.faster_whisper_model == 'loaded:base'


def test_the_update_model_button_does_nothing_for_another_engine(harness):
    _save(harness, _form(engine='openai', load=True))

    assert harness.loads == []


def test_a_new_model_that_cannot_load_refuses_the_save_and_stores_nothing(harness, monkeypatch):
    monkeypatch.setenv('HF_HUB_OFFLINE', '1')
    harness.state.fail.add('large-v3')

    with pytest.raises(HTTPException) as raised:
        _save(harness, _form(voice='nova', whisper='large-v3'))

    assert raised.value.status_code == 400
    assert 'large-v3' in raised.value.detail
    assert 'not saved' in raised.value.detail
    assert 'is not in the cache' in raised.value.detail
    assert 'runs offline' in raised.value.detail
    assert _stored('audio.stt.whisper_model') == 'base'
    assert _stored('audio.tts.voice') == 'start'


def test_online_the_error_does_not_blame_offline_mode(harness, monkeypatch):
    monkeypatch.delenv('HF_HUB_OFFLINE', raising=False)
    harness.state.fail.add('bse')

    with pytest.raises(HTTPException) as raised:
        _save(harness, _form(whisper='bse'))

    assert 'bse' in raised.value.detail
    assert 'offline' not in raised.value.detail


def test_a_new_model_that_loads_is_saved_and_used(harness):
    _save(harness, _form(whisper='small'))

    assert harness.loads == ['small']
    assert _stored('audio.stt.whisper_model') == 'small'
    assert harness.request.app.state.faster_whisper_model == 'loaded:small'


def test_switching_to_another_engine_unloads_the_model_without_loading(harness):
    harness.request.app.state.faster_whisper_model = 'loaded:base'

    _save(harness, _form(engine='openai'))

    assert harness.loads == []
    assert harness.request.app.state.faster_whisper_model is None
    assert _stored('audio.stt.engine') == 'openai'


def test_switching_back_to_the_local_engine_loads_its_model(harness):
    _save(harness, _form(engine='openai'))

    _save(harness, _form(engine='', whisper='base'))

    assert harness.loads == ['base']
    assert harness.request.app.state.faster_whisper_model == 'loaded:base'
