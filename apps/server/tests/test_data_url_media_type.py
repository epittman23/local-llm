"""The media type read from a data URL's header (ruff B005).

These parsers used `.lstrip('data:')`, which strips any leading run of the
characters d, a, t and ':' rather than the prefix: `data:application/pdf`
became `pplication/pdf` and `data:text/plain` became `ext/plain`. Image
types came through by luck (no image subtype starts with one of those
characters). They now remove the prefix.

Run from apps/server:

    python -m pytest tests/test_data_url_media_type.py
"""

from __future__ import annotations

import asyncio
import base64

import pytest

from local_llm.routers import images

PAYLOAD = base64.b64encode(b'not really an image').decode()


@pytest.mark.parametrize(
    ('media_type', 'extension'),
    [
        ('image/png', '.png'),
        ('image/webp', '.webp'),
        ('application/pdf', '.pdf'),
        ('text/plain', '.txt'),
        ('audio/mpeg', '.mp3'),
    ],
)
def test_an_upload_keeps_its_media_type(media_type, extension):
    name, (filename, body, sent_type) = images.get_image_file_item(f'data:{media_type};base64,{PAYLOAD}')

    assert name == 'image'
    assert sent_type == media_type
    assert filename.endswith(extension)
    assert body.read() == b'not really an image'


def test_an_upload_without_a_media_type_is_sent_as_png():
    _, (filename, _, sent_type) = images.get_image_file_item(f'data:;base64,{PAYLOAD}')

    assert sent_type == 'image/png'
    assert filename.endswith('.png')


@pytest.mark.parametrize('media_type', ['image/png', 'application/octet-stream', 'text/plain'])
def test_image_data_keeps_its_media_type(media_type):
    data, sent_type = asyncio.run(images.get_image_data(f'data:{media_type};base64,{PAYLOAD}'))

    assert data == b'not really an image'
    assert sent_type == media_type


def test_an_edit_of_a_non_jpeg_is_left_alone():
    url = f'data:application/jpeg-ish;base64,{PAYLOAD}'

    assert images.normalize_openai_edit_image_data_url(url) == url
