"""Image settings Verify checks the server of the engine it belongs to (#236).

Admin > Images has a Verify button for the generation engine's server and
another for the edit engine's ComfyUI server. Both called
`/images/config/url/verify`, which checked only the generation engine: with
generation on OpenAI and edits on ComfyUI at a wrong URL, the edit Verify
said "Server connection verified". The endpoint now takes `target=edit` for
the edit engine; without it, it checks the generation engine as before.

Run from apps/server:

    python -m pytest tests/test_image_verify_target.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import images

CONFIG = SimpleNamespace(
    IMAGE_GENERATION_ENGINE='openai',
    AUTOMATIC1111_BASE_URL='http://sd:7860',
    COMFYUI_BASE_URL='http://gen-comfy:8188',
    COMFYUI_API_KEY='',
    IMAGE_EDIT_ENGINE='comfyui',
    IMAGES_EDIT_COMFYUI_BASE_URL='http://edit-comfy:8188',
    IMAGES_EDIT_COMFYUI_API_KEY='edit-key',
)


@pytest.fixture
def server(monkeypatch):
    """Records each URL checked; `down` lists the hosts that answer 500."""
    state = SimpleNamespace(checked=[], down=set())

    class _Response:
        def __init__(self, url):
            self.url = url

        def raise_for_status(self):
            if any(host in self.url for host in state.down):
                raise RuntimeError('500')

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Session:
        def get(self, url, headers=None, ssl=None):
            state.checked.append((url, headers))
            return _Response(url)

    async def session():
        return _Session()

    def config(**over):
        async def get():
            return SimpleNamespace(**{**vars(CONFIG), **over})

        monkeypatch.setattr(images, 'get_image_config', get)

    monkeypatch.setattr(images, 'get_session', session)
    config()
    state.config = config
    return state


def _verify(target='generation'):
    return asyncio.run(images.verify_url(request=None, target=target, user=None))


def test_the_edit_target_checks_the_edit_comfyui_server(server):
    assert _verify('edit') is True
    assert server.checked == [('http://edit-comfy:8188/object_info', {'Authorization': 'Bearer edit-key'})]


def test_a_wrong_edit_url_is_refused_even_when_generation_needs_no_check(server):
    server.down.add('edit-comfy')

    with pytest.raises(HTTPException) as exc:
        _verify('edit')

    assert exc.value.status_code == 400
    # The generation engine (OpenAI) has nothing to check, as before.
    assert _verify() is True


def test_an_edit_engine_without_a_server_has_nothing_to_check(server):
    server.config(IMAGE_EDIT_ENGINE='openai')

    assert _verify('edit') is True
    assert server.checked == []


def test_the_generation_target_still_checks_the_generation_server(server):
    server.config(IMAGE_GENERATION_ENGINE='comfyui')
    server.down.add('edit-comfy')

    assert _verify() is True
    assert server.checked == [('http://gen-comfy:8188/object_info', None)]


def test_an_unreachable_generation_comfyui_is_refused(server):
    server.config(IMAGE_GENERATION_ENGINE='comfyui')
    server.down.add('gen-comfy')

    with pytest.raises(HTTPException):
        _verify()
