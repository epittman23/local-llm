"""A malformed image edit size is refused on save and never breaks an edit (#344).

Only IMAGE_SIZE was checked on save, so an edit size like `1024x` or
`1024 x 1024 px` was stored, and every image edit then failed with a 500:
`_edit_size` split it on 'x' and int() raised. Now the save refuses it as
it refuses such an IMAGE_SIZE, and an edit skips any size it cannot read
(one saved before, or one in the request) as it already skipped `auto`.

Run from apps/server:

    python -m pytest tests/test_image_edit_size.py
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


def _update(**over):
    form = images.ImagesConfig(**_form(**over))
    return asyncio.run(images.update_config(request=SimpleNamespace(), form_data=form, user=None))


@pytest.mark.parametrize('size', ['1024x', '1024 x 1024 px', '1024X1024', 'x512', 'big'])
def test_a_malformed_edit_size_is_refused_on_save(saved, size):
    with pytest.raises(HTTPException) as raised:
        _update(IMAGE_EDIT_SIZE=size)

    assert raised.value.status_code == 400
    assert saved == []


@pytest.mark.parametrize('size', ['512x512', '', None, 'auto'])
def test_a_well_formed_or_empty_edit_size_is_saved(saved, size):
    _update(IMAGE_EDIT_SIZE=size)

    assert len(saved) == 1


def _size(requested, configured):
    form = images.EditImageForm(image='data:,', prompt='p', size=requested)
    return images._edit_size(SimpleNamespace(IMAGE_EDIT_SIZE=configured), form)


def test_an_edit_skips_a_size_it_cannot_read():
    assert _size(None, '1024x') == (None, None, None)
    assert _size('1024 x 1024 px', '512x768') == ('512x768', 512, 768)
    assert _size('256x256', '1024x') == ('256x256', 256, 256)
    assert _size('auto', None) == (None, None, None)
