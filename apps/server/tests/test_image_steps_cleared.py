"""A cleared Steps field in admin Images settings saves as no step count (#237).

The Steps box, cleared, was sent as `''`, which `ImagesConfig.IMAGE_STEPS`
(`int | None`) refused with a 422, failing the whole save (reachable through
Verify, which saves without the form's own validation, or with the field
hidden). And a null would have reached `IMAGE_STEPS < 0` and raised a
TypeError. Now `''` and null are both no step count, so the engine's own
default applies, as a null already does when generating; negative values are
still refused.

Run from apps/server:

    python -m pytest tests/test_image_steps_cleared.py
"""

from __future__ import annotations

import asyncio
import typing
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from local_llm.routers import images


def _form(**over):
    """An ImagesConfig with every field set to a plain value of its type."""
    plain = {str: '', bool: False, int: 0, list: [], dict: {}}
    data = {}
    for name, field in images.ImagesConfig.model_fields.items():
        kind = typing.get_origin(field.annotation) or field.annotation
        # `X | None`: the plain value of X.
        options = [kind] if kind in plain else [typing.get_origin(t) or t for t in typing.get_args(field.annotation)]
        data[name] = next((plain[k] for k in options if k in plain), None)
    data.update(IMAGE_GENERATION_ENGINE='automatic1111', IMAGE_SIZE='512x512', IMAGE_STEPS=50)
    data.update(over)
    return data


@pytest.mark.parametrize('cleared', ['', None])
def test_a_cleared_steps_box_is_no_step_count(cleared):
    assert images.ImagesConfig(**_form(IMAGE_STEPS=cleared)).IMAGE_STEPS is None


def test_a_number_is_kept_and_text_is_still_refused():
    assert images.ImagesConfig(**_form(IMAGE_STEPS=30)).IMAGE_STEPS == 30
    with pytest.raises(ValidationError):
        images.ImagesConfig(**_form(IMAGE_STEPS='lots'))


@pytest.fixture
def saved(monkeypatch):
    stored = []

    async def upsert(updates):
        stored.append(updates)

    async def values(keys):
        return {}

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(images.Config, 'upsert', upsert)
    monkeypatch.setattr(images, 'get_config_values', values)
    monkeypatch.setattr(images, 'publish_event', publish)
    monkeypatch.setattr(images, 'set_image_model', publish)
    return stored


def _update(form):
    return asyncio.run(images.update_config(request=SimpleNamespace(), form_data=form, user=None))


@pytest.mark.parametrize('cleared', ['', None])
def test_saving_with_no_step_count_stores_none(saved, cleared):
    _update(images.ImagesConfig(**_form(IMAGE_STEPS=cleared)))

    assert saved[0]['image_generation.steps'] is None


def test_a_negative_step_count_is_still_refused(saved):
    with pytest.raises(HTTPException) as exc:
        _update(images.ImagesConfig(**_form(IMAGE_STEPS=-1)))

    assert exc.value.status_code == 400
    assert saved == []
