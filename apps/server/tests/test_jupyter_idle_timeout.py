"""A cleared Jupyter timeout still bounds a run (#247).

Admin > Code Execution saves a cleared timeout as null, and the server's
`int | None` field accepts it. Passed through as is, null became
`asyncio.wait_for(ws.recv(), None)`, so code that printed nothing kept a
chat turn waiting forever.
"""

import asyncio

import pytest

from local_llm.utils import code_interpreter as ci


class _Executer:
    seen: list = []

    def __init__(self, base_url, code, token, password, idle_timeout, files):
        type(self).seen.append(idle_timeout)

    async def __aenter__(self):
        raise RuntimeError('stop here')

    async def __aexit__(self, *exc):
        return False


@pytest.mark.parametrize(('given', 'used'), [(None, 60), (0, 60), (-5, 60), (90, 90)])
def test_a_missing_or_non_positive_timeout_falls_back_to_the_default(monkeypatch, given, used):
    _Executer.seen = []
    monkeypatch.setattr(ci, 'JupyterCodeExecuter', _Executer)

    with pytest.raises(RuntimeError, match='stop here'):
        asyncio.run(ci.execute_code_jupyter('http://jupyter', 'print(1)', idle_timeout=given))

    assert _Executer.seen == [used]
