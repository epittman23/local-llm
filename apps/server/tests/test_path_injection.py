"""Request-supplied names can't escape their directory (CodeQL py/path-injection)."""

import pytest

from local_llm.benchmarks.evaluation import runner
from local_llm.routers.ollama import parse_huggingface_url, upload_path_for


def test_system_prompt_names_must_be_listed(tmp_path, monkeypatch):
    (tmp_path / 'terse.txt').write_text('Answer briefly.\n')
    (tmp_path.parent / 'outside.txt').write_text('secret')
    monkeypatch.setattr(runner, 'PROMPTS_DIR', tmp_path)
    assert runner.load_system('terse')['text'] == 'Answer briefly.'
    for name in ('../outside', '/etc/hostname', 'terse/../../outside', 'missing'):
        with pytest.raises(runner.SuiteLoadError):
            runner.load_system(name)


@pytest.mark.parametrize(
    'url,ok',
    [
        ('https://huggingface.co/org/repo/resolve/main/model.Q4_K_M.gguf', True),
        ('https://huggingface.co/org/repo/..', False),
        ('https://huggingface.co/org/repo/.', False),
        ('https://huggingface.co/org/repo/', False),
        ('https://huggingface.co/org/%2e%2e', True),  # stays a literal file name, not `..`
    ],
)
def test_download_file_stays_in_upload_dir(tmp_path, url, ok):
    path = upload_path_for(parse_huggingface_url(url), str(tmp_path))
    assert (path is not None) is ok
    if path:
        assert path.startswith(str(tmp_path) + '/')


@pytest.mark.parametrize('module', ['functions', 'tools'])
@pytest.mark.parametrize('url', ['http://127.0.0.1:8080/x.py', 'http://169.254.169.254/latest/meta-data'])
def test_import_from_url_rejects_internal_addresses(monkeypatch, module, url):
    """Load-from-URL fetches go through validate_url (CodeQL py/full-ssrf)."""
    import asyncio
    import importlib

    from fastapi import HTTPException

    from local_llm.constants import ERROR_MESSAGES
    from local_llm.retrieval.web import utils as web_utils

    monkeypatch.setattr(web_utils, 'ENABLE_LOCAL_WEB_FETCH', False, raising=False)
    router = importlib.import_module(f'local_llm.routers.{module}')
    load = router.load_function_from_url if module == 'functions' else router.load_tool_from_url
    with pytest.raises(HTTPException) as exc:
        asyncio.run(load(request=None, form_data=router.LoadUrlForm(url=url), user=None))
    # Rejected by validate_url before any connection, not merely failing to connect.
    assert ERROR_MESSAGES.INVALID_URL in str(exc.value.detail)
