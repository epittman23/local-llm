"""Outputs (T17's acceptance test) in a real sandbox: the Kata backend through SandboxManager and `bash`.

Skipped unless LLLM_TEST_KATA=1 (owner decision Q3), like
test_sandbox_kata.py, whose fixtures it uses and whose needs it shares
(Docker with `kata-clh`, both sandbox images, udisks2 and an active local
login session). Pins that:

- a matplotlib figure saved to /workspace/outputs comes back in the bash
  result's `outputs` as a File row marked `meta.source = 'sandbox_output'`,
  holding the PNG, linked to the message, and sent in the `files` event;
- a PDF saved there gets preview PNGs from the image's pdftoppm, one per
  page, each a File row with `meta.preview_of` naming the PDF's row;
- a file `write_file` puts in /workspace/outputs is attached by the next
  bash call;
- each `files` event carries the call's new files, and saved as the socket
  saves it, the message holds every call's;
- an unchanged file is not attached again.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_TEST_KATA=1 LLLM_SECRET_KEY=... uv run --frozen python -m pytest tests/test_sandbox_outputs_kata.py -v -s
"""

import asyncio
import json
import os
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

if os.environ.get('LLLM_TEST_KATA') != '1':
    pytest.skip('set LLLM_TEST_KATA=1 on a host with Docker and Kata (kata-clh) to run these', allow_module_level=True)

import test_sandbox_kata as kata_tests
from fastapi import FastAPI

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.sandbox.kata import KataDockerBackend
from local_llm.sandbox.limits import PREVIEW_MAX_SIDE
from local_llm.sandbox.manager import SandboxManager, SandboxSettings
from local_llm.sandbox.workspace import image_size
from local_llm.socket.main import merge_message_files
from local_llm.storage.provider import Storage
from local_llm.tools import builtin

# test_sandbox_kata.py's fixtures, taken by name: its Docker client, sandbox network, keys and backend.
client = kata_tests.client
network = kata_tests.network
keys = kata_tests.keys
backend = kata_tests.backend
Keys = kata_tests.Keys

FIGURE = (
    'mkdir -p outputs && python -c "'
    "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; "
    "plt.plot([1, 3, 2]); plt.title('outputs'); plt.savefig('outputs/figure.png', dpi=72)"
    '"'
)
REPORT = (
    'python -c "'
    "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; "
    'from matplotlib.backends.backend_pdf import PdfPages\n'
    "with PdfPages('outputs/report.pdf') as pdf:\n"
    '    for n in range(2):\n'
    '        plt.figure(); plt.plot([n, 2 * n]); pdf.savefig(); plt.close()'
    '"'
)


class _Chats:
    def __init__(self, chat_id: str) -> None:
        self.chat_id = chat_id

    async def usable(self, chat_id, user):
        return chat_id == self.chat_id

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


def _stored(file_id: str) -> tuple[dict, bytes]:
    row = asyncio.run(Files.get_file_by_id(file_id))
    assert row is not None and row.meta is not None and row.path
    return row.meta, Path(Storage.get_file(row.path)).read_bytes()


def test_a_figure_and_a_pdf_in_outputs_come_back_on_the_message(backend: KataDockerBackend, keys: Keys) -> None:
    chat = keys.new(backend)
    tag = uuid.uuid4().hex[:8]
    user = asyncio.run(Users.insert_new_user(f'kata-o-{tag}', 'Owner', f'kata-o-{tag}@example.invalid', role='user'))
    history = {'messages': {'m1': {'id': 'm1', 'role': 'assistant'}}}
    asyncio.run(Chats.insert_new_chat(chat, user.id, ChatForm(chat={'title': 'Outputs', 'history': history})))
    manager = SandboxManager(backend, chats=_Chats(chat), settings=_settings)
    app = FastAPI()
    app.include_router(files_router.router, prefix='/api/v1/files')
    app.state.sandbox = manager
    request = SimpleNamespace(app=app, state=SimpleNamespace())
    events: list[dict] = []

    async def emit(event: dict) -> None:
        # Saved as socket/main.py saves a saved chat's `files` event, so the next event starts from it.
        events.append(event)
        if event['type'] == 'files':
            existing = await Chats.get_message_metadata(chat, 'm1', 'files')
            merged = merge_message_files(existing, event['data']['files'])
            await Chats.upsert_message_to_chat_by_id_and_message_id(chat, 'm1', {'files': merged}, touch=False)

    async def bash(command: str) -> dict:
        out = await builtin.bash(
            command=command,
            timeout_s=120,
            __request__=request,
            __user__={'id': user.id},
            __chat_id__=chat,
            __message_id__='m1',
            __event_emitter__=emit,
        )
        return json.loads(out)

    async def go() -> tuple[dict, dict, dict, dict]:
        try:
            figure = await bash(FIGURE)
            report = await bash(REPORT)
            await builtin.write_file(
                path='outputs/notes.md',
                content='# Notes\n',
                __request__=request,
                __user__={'id': user.id},
                __chat_id__=chat,
            )
            written = await bash('ls outputs')
            again = await bash('ls outputs')
        finally:
            await manager.release(chat)
        return figure, report, written, again

    figure, report, written, again = asyncio.run(go())
    print('\nfigure:', json.dumps(figure['outputs']))
    print('report:', json.dumps(report['outputs']))

    assert figure['returncode'] == 0, figure
    (shown,) = figure['outputs']
    assert (shown['path'], shown['content_type']) == ('outputs/figure.png', 'image/png'), shown
    meta, data = _stored(shown['file_id'])
    assert meta['source'] == 'sandbox_output' and meta['sandbox_path'] == '/workspace/outputs/figure.png'
    assert data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) == shown['size']
    print('figure.png:', image_size(data, 'image/png'), f'{len(data)} bytes')

    assert report['returncode'] == 0, report
    (pdf,) = report['outputs']
    assert (pdf['path'], pdf['content_type']) == ('outputs/report.pdf', 'application/pdf'), pdf
    pdf_meta, pdf_data = _stored(pdf['file_id'])
    assert pdf_meta['source'] == 'sandbox_output' and pdf_data.startswith(b'%PDF')
    files_events = [e['data']['files'] for e in events if e['type'] == 'files']
    previews = [f for f in files_events[1] if f['meta'].get('preview_of') == pdf['file_id']]
    assert [f['meta']['preview_page'] for f in previews] == [1, 2], files_events[1]
    for preview in previews:
        meta, data = _stored(preview['id'])
        assert meta['source'] == 'sandbox_output' and meta['content_type'] == 'image/png'
        size = image_size(data, 'image/png')
        assert size is not None and max(size) <= PREVIEW_MAX_SIDE
        print(f'{preview["name"]}: {size}, {len(data)} bytes')

    # One event per call that attached something, with its new files; saved as the socket saves them, the message
    # holds them all.
    notes = written['outputs'][0]['file_id']
    assert len(files_events) == 3
    assert [f['id'] for f in files_events[0]] == [shown['file_id']]
    assert [f['id'] for f in files_events[1]] == [pdf['file_id'], *(f['id'] for f in previews)]
    assert [f['id'] for f in files_events[2]] == [notes]
    saved = asyncio.run(Chats.get_message_metadata(chat, 'm1', 'files'))
    assert [f['id'] for f in saved] == [f['id'] for e in files_events for f in e]
    linked = asyncio.run(Chats.get_chat_files_by_chat_id_and_message_id(chat, 'm1'))
    assert {c.file_id for c in linked} == {shown['file_id'], pdf['file_id'], notes, *(f['id'] for f in previews)}
    # A file write_file put in outputs is attached by the next bash call, and an unchanged one never again.
    assert [o['path'] for o in written['outputs']] == ['outputs/notes.md'], written
    assert again['outputs'] == [] and again['stdout'].split() == ['figure.png', 'notes.md', 'report.pdf'], again
