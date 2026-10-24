"""File and process work moved off the event loop (ruff's ASYNC rules), and the
APIs reshaped so async functions take no `timeout` (ASYNC109).

Each moved check keeps its logic: the cache route still refuses a path
outside the cache, the audio handlers still refuse a missing or oversized
file, the legacy config is still imported and renamed, a report is still
written beside its figures, the SSRF-safe connector still checks the host
and passes aiohttp's arguments through, and the Jupyter runner's
`idle_timeout` is still the per-message wait.

Run from apps/server:

    python -m pytest tests/test_async_file_io.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm import config as config_module
from local_llm import main
from local_llm.retrieval.web import utils as web_utils
from local_llm.routers import audio, ollama
from local_llm.routers.benchmarks import report as report_router
from local_llm.utils import code_interpreter

# -- the cache route -------------------------------------------------------


@pytest.fixture
def cache(monkeypatch, tmp_path):
    root = tmp_path / 'cache'
    (root / 'images').mkdir(parents=True)
    (root / 'images' / 'a.png').write_bytes(b'png')
    (root / 'page.html').write_text('<script>')
    (tmp_path / 'cache_backup').mkdir()
    (tmp_path / 'cache_backup' / 'secret.txt').write_text('no')
    monkeypatch.setattr(main, 'CACHE_DIR', str(root))
    return root


def test_cache_file_path_finds_a_file_in_the_cache(cache):
    assert main._cache_file_path('images/a.png') == str(cache / 'images' / 'a.png')


@pytest.mark.parametrize('path', ['../cache_backup/secret.txt', '../../etc/passwd', 'images', 'missing.png'])
def test_cache_file_path_refuses_what_is_not_a_cached_file(cache, path):
    assert main._cache_file_path(path) is None


def test_the_cache_route_serves_inline_only_media(cache):
    image = asyncio.run(main.serve_cache_file('images/a.png', user=None))
    page = asyncio.run(main.serve_cache_file('page.html', user=None))

    assert 'content-disposition' not in image.headers
    assert page.headers['content-disposition'] == 'attachment; filename="page.html"'


def test_the_cache_route_404s_outside_the_cache(cache):
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.serve_cache_file('../cache_backup/secret.txt', user=None))
    assert e.value.status_code == 404


# -- the legacy config.json import --------------------------------------------


def test_a_legacy_config_json_is_imported_then_renamed(monkeypatch, tmp_path):
    (tmp_path / 'config.json').write_text('{"ui": {"name": "x"}}')
    upserted = []

    async def upsert(data):
        upserted.append(data)

    monkeypatch.setattr(config_module, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config_module.Config, 'upsert', upsert)

    asyncio.run(config_module.import_legacy_config_json())

    assert upserted == [{'ui': {'name': 'x'}}]
    assert not (tmp_path / 'config.json').exists()
    assert (tmp_path / 'old_config.json').exists()


def test_no_legacy_config_json_is_nothing_to_do(monkeypatch, tmp_path):
    async def upsert(data):
        raise AssertionError('nothing to import')

    monkeypatch.setattr(config_module, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config_module.Config, 'upsert', upsert)

    asyncio.run(config_module.import_legacy_config_json())


# -- the benchmark report -------------------------------------------------------


def test_a_report_is_written_with_its_figures(tmp_path):
    result = SimpleNamespace(
        markdown='# report',
        figures=[SimpleNamespace(name='fig1.png', data=b'\x89PNG'), SimpleNamespace(name='fig2.png', data=b'2')],
    )

    report_router._write_report(tmp_path / 'run', result)

    assert (tmp_path / 'run' / 'report.md').read_text() == '# report'
    assert (tmp_path / 'run' / 'fig1.png').read_bytes() == b'\x89PNG'
    assert (tmp_path / 'run' / 'fig2.png').read_bytes() == b'2'


# -- audio ----------------------------------------------------------------------


def test_resolves_within(tmp_path):
    assert audio._resolves_within(str(tmp_path / 'a.webm'), str(tmp_path))
    assert not audio._resolves_within(str(tmp_path / '..' / 'a.webm'), str(tmp_path))


@pytest.mark.parametrize(
    'transcribe',
    [
        lambda path: audio._transcribe_azure(None, path, 'a.wav', '/tmp', 'id'),
        lambda path: audio._transcribe_mistral(None, path, 'a.wav', None, '/tmp', 'id'),
    ],
    ids=['azure', 'mistral'],
)
def test_a_missing_recording_is_refused(tmp_path, transcribe):
    with pytest.raises(HTTPException) as e:
        asyncio.run(transcribe(str(tmp_path / 'gone.wav')))
    assert e.value.status_code == 400
    assert e.value.detail == 'Audio file not found'


@pytest.mark.parametrize(
    ('transcribe', 'limit'),
    [
        (lambda path: audio._transcribe_azure(None, path, 'a.wav', '/tmp', 'id'), 'AZURE_MAX_FILE_SIZE'),
        (lambda path: audio._transcribe_mistral(None, path, 'a.wav', None, '/tmp', 'id'), 'MAX_FILE_SIZE'),
    ],
    ids=['azure', 'mistral'],
)
def test_an_oversized_recording_is_refused(monkeypatch, tmp_path, transcribe, limit):
    recording = tmp_path / 'big.wav'
    recording.write_bytes(b'x' * 64)
    monkeypatch.setattr(audio, limit, 16)

    with pytest.raises(HTTPException) as e:
        asyncio.run(transcribe(str(recording)))
    assert e.value.status_code == 400
    assert 'exceeds' in e.value.detail


# -- ollama model download --------------------------------------------------------


def test_a_partial_download_resumes_from_its_size(monkeypatch, tmp_path):
    partial = tmp_path / 'model.gguf'
    partial.write_bytes(b'abc')
    seen = {}

    async def chunks(_size):
        yield b'de'

    class Response:
        headers = {'content-length': '2'}
        content = SimpleNamespace(iter_chunked=chunks)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class Session:
        def get(self, url, headers, **_kwargs):
            seen['headers'] = headers
            return Response()

    async def get_session():
        return Session()

    monkeypatch.setattr(ollama, 'get_session', get_session)

    async def first_event():
        stream = ollama.download_file_stream('http://ollama.invalid', 'http://hf.invalid/m', str(partial), 'm')
        try:
            return await anext(stream)
        finally:
            await stream.aclose()

    event = asyncio.run(first_event())

    assert seen['headers'] == {'Range': 'bytes=3-'}
    assert event == 'data: {"progress": 100.0, "completed": 5, "total": 5}\n\n'
    assert partial.read_bytes() == b'abcde'


# -- the SSRF-safe connector ---------------------------------------------------------


def test_the_ssrf_safe_connector_checks_the_host_and_passes_everything_on(monkeypatch):
    forwarded = []
    checked = []

    async def connect(self, req, *args, **kwargs):
        forwarded.append((req, args, kwargs))
        return 'connection'

    monkeypatch.setattr(web_utils.aiohttp.TCPConnector, 'connect', connect)
    monkeypatch.setattr(web_utils, '_assert_host_allowed', checked.append)
    req = SimpleNamespace(url=SimpleNamespace(host='example.com'))

    async def scenario():
        connector = web_utils._SSRFSafeConnector()
        try:
            # aiohttp's ClientSession passes traces and timeout by keyword.
            return await connector.connect(req, traces=['t'], timeout='timeout')
        finally:
            await connector.close()

    assert asyncio.run(scenario()) == 'connection'
    assert checked == ['example.com']
    assert forwarded == [(req, (), {'traces': ['t'], 'timeout': 'timeout'})]


# -- the Jupyter runner -----------------------------------------------------------------


def test_execute_code_jupyter_passes_the_idle_timeout_to_the_executor(monkeypatch):
    made = []

    class Executor:
        def __init__(self, base_url, code, token, password, timeout, files=None):
            made.append((base_url, code, token, password, timeout))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def run(self):
            return code_interpreter.ResultModel(stdout='out')

    monkeypatch.setattr(code_interpreter, 'JupyterCodeExecuter', Executor)

    result = asyncio.run(code_interpreter.execute_code_jupyter('http://j.invalid', 'print(1)', 't', '', 7))

    assert made == [('http://j.invalid', 'print(1)', 't', '', 7)]
    assert result['stdout'] == 'out'


def test_the_report_route_writes_the_report_under_its_run_directory(monkeypatch, tmp_path):
    result = SimpleNamespace(markdown='# r', figures=[SimpleNamespace(name='fig1.png', data=b'1')], windows=[])

    async def build_report(**_kwargs):
        return result

    monkeypatch.setattr(report_router.report_logic, 'build_report', build_report)
    monkeypatch.setattr(report_router, 'REPORTS_DIR', tmp_path)

    out = asyncio.run(report_router.generate_report(report_router.ReportForm(), user=None))

    (run_dir,) = list(tmp_path.iterdir())
    assert out['markdown_url'].endswith(f'/{run_dir.name}/report.md')
    assert (run_dir / 'report.md').read_text() == '# r'
    assert (run_dir / 'fig1.png').read_bytes() == b'1'
