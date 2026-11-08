"""A malformed image generation size is a 400, and never breaks the save (#653).

`_generation_size` split any size with an 'x' in it and called int(), so a
requested `1024x` was a 500 from `/images/generations`, and a configured one
failed every generation. The save ran `re.match` on `IMAGE_SIZE`, so a null
raised a TypeError, and it checked the size even while generation was off and
the page hid the box, so a malformed stored value blocked every save. Now
generation reads sizes as `_edit_size` does (#344): a requested size it cannot
read is refused, a configured one is skipped. The save treats a null as empty,
uses the same full match, and checks the size only while generation is on.

Run from apps/server:

    python -m pytest tests/test_image_generation_size.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import images
from tests.test_image_steps_cleared import _form


@pytest.fixture
def saved(monkeypatch):
    stored = []

    async def upsert(updates):
        stored.append(updates)

    async def values(_keys):
        return {}

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(images.Config, 'upsert', upsert)
    monkeypatch.setattr(images, 'get_config_values', values)
    monkeypatch.setattr(images, 'publish_event', nothing)
    monkeypatch.setattr(images, 'set_image_model', nothing)
    return stored


def _size(requested, configured):
    form = images.CreateImageForm(prompt='p', size=requested)
    return images._generation_size(SimpleNamespace(IMAGE_SIZE=configured), form)


@pytest.mark.parametrize('size', ['1024x', 'x512', 'big', '1024X1024', '512x512\n'])
def test_a_generation_refuses_a_requested_size_it_cannot_read(size):
    with pytest.raises(HTTPException) as raised:
        _size(size, '512x512')

    assert (raised.value.status_code, raised.value.detail) == (400, images.GENERATION_SIZE_FORMAT)


def test_a_generation_skips_a_configured_size_it_cannot_read():
    assert _size(None, '1024x') == (512, 512)
    assert _size(None, '1024X1024') == (512, 512)
    assert _size('256x256', '1024x') == (256, 256)


def test_a_generation_takes_a_size_it_can_read():
    assert _size(None, '512x768') == (512, 768)
    assert _size('256x256', '512x768') == (256, 256)
    assert _size('auto', '512x768') == (512, 768)
    assert _size(None, 'auto') == (512, 512)
    assert _size('', '') == (512, 512)


def _update(**over):
    form = images.ImagesConfig(**_form(**{'ENABLE_IMAGE_GENERATION': True, **over}))
    return asyncio.run(images.update_config(request=SimpleNamespace(), form_data=form, user=None))


@pytest.mark.parametrize('size', [None, '', '512x512'])
def test_a_null_empty_or_well_formed_image_size_is_saved(saved, size):
    _update(IMAGE_SIZE=size)

    assert len(saved) == 1


@pytest.mark.parametrize('size', ['1024x', '1024X1024', '512x512\n'])
def test_a_malformed_image_size_is_refused_on_save(saved, size):
    with pytest.raises(HTTPException) as raised:
        _update(IMAGE_SIZE=size)

    assert raised.value.status_code == 400
    assert saved == []


@pytest.mark.parametrize('size', ['1024x', 'auto', None])
def test_an_image_size_the_page_hides_never_blocks_a_save(saved, size):
    # With generation off the page hides the size and the model, so neither a
    # malformed size nor `auto` with a model that cannot take it is checked.
    _update(ENABLE_IMAGE_GENERATION=False, IMAGE_SIZE=size, IMAGE_GENERATION_MODEL='dall-e-2')

    assert len(saved) == 1
