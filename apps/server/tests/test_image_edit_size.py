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
    form = images.ImagesConfig(**_form(**{'ENABLE_IMAGE_GENERATION': True, 'ENABLE_IMAGE_EDIT': True, **over}))
    return asyncio.run(images.update_config(request=SimpleNamespace(), form_data=form, user=None))


@pytest.mark.parametrize('size', ['1024x', '1024 x 1024 px', '1024X1024', 'x512', 'big', '512x512\n'])
def test_a_malformed_edit_size_is_refused_on_save(saved, size):
    with pytest.raises(HTTPException) as raised:
        _update(IMAGE_EDIT_SIZE=size)

    assert (raised.value.status_code, raised.value.detail) == (400, images.EDIT_SIZE_FORMAT)
    assert saved == []


@pytest.mark.parametrize('switched_off', ['ENABLE_IMAGE_EDIT', 'ENABLE_IMAGE_GENERATION'])
def test_an_edit_size_the_page_hides_never_blocks_a_save(saved, switched_off):
    _update(IMAGE_EDIT_SIZE='1024x', **{switched_off: False})

    assert len(saved) == 1


@pytest.mark.parametrize('size', ['512x512', '', None, 'auto'])
def test_a_well_formed_or_empty_edit_size_is_saved(saved, size):
    _update(IMAGE_EDIT_SIZE=size)

    assert len(saved) == 1


def _size(requested, configured):
    form = images.EditImageForm(image='data:,', prompt='p', size=requested)
    return images._edit_size(SimpleNamespace(IMAGE_EDIT_SIZE=configured), form)


def test_an_edit_skips_a_configured_size_it_cannot_read():
    assert _size(None, '1024x') == (None, None, None)
    assert _size(None, '512x768') == ('512x768', 512, 768)
    assert _size('256x256', '1024x') == ('256x256', 256, 256)
    assert _size('auto', '512x512\n') == (None, None, None)


@pytest.mark.parametrize('size', ['1024x', '1024 x 1024 px', '1024X1024'])
def test_an_edit_refuses_a_requested_size_it_cannot_read(size):
    with pytest.raises(HTTPException) as raised:
        _size(size, '512x512')

    assert (raised.value.status_code, raised.value.detail) == (400, images.EDIT_SIZE_FORMAT)


# The size is read by splitting it, not with a regex: a long requested value of
# digits made the regex backtrack (CodeQL, polynomial regular expression).


def test_a_size_is_read_as_two_whole_numbers():
    from local_llm.routers.images import _parse_size

    assert _parse_size('512x512') == (512, 512)
    assert _parse_size('1024x768') == (1024, 768)
    for bad in (None, '', 'auto', '512', 'x512', '512x', '512x512x2', ' 512x512', '512 x 512', '-1x5', '²x²', '٥x٥'):
        assert _parse_size(bad) is None, bad


def test_a_very_long_size_is_refused_at_once():
    import time

    from local_llm.routers.images import _parse_size

    started = time.perf_counter()
    assert _parse_size('0' * 200_000 + 'y') is None
    assert _parse_size('0' * 200_000 + 'x1') is None
    assert time.perf_counter() - started < 0.1
