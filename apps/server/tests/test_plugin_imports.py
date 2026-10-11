"""Stored or pasted plugin source written against the package's old name still loads.

The package was renamed from open_webui to local_llm on 2026-10-10, and many
WEBUI_* names became LLLM_* the same day. Tool and Function source in the
database (and community plugins pasted in later) imports `open_webui.*` in
any form Python allows; utils/plugin.py aliases the old package to this one
at import time, and env.py and config.py resolve the old names.
"""

import asyncio
import sys

import pytest

import local_llm.utils.misc
from local_llm import config, env
from local_llm.utils.plugin import load_tool_module_by_id, replace_imports

OLD_STYLE_TOOL = """
import os, open_webui.utils.misc
import open_webui.models.users as users_module
import importlib
from open_webui.config import WEBUI_NAME, WEBUI_URL, CUSTOM_NAME
from open_webui.env import BASE_DIR, OPEN_WEBUI_DIR, WEBUI_SECRET_KEY, LICENSE_KEY

TYPE = 'open_webui:code_interpreter'
required_open_webui_version = "0.11.3"


class Tools:
    misc = open_webui.utils.misc
    users_module = users_module
    users_by_name = importlib.import_module('open_webui.models.users')
    names = (WEBUI_NAME, CUSTOM_NAME, BASE_DIR, OPEN_WEBUI_DIR, WEBUI_SECRET_KEY, WEBUI_URL, LICENSE_KEY)
"""


def _load(content, tool_id='old_style'):
    tool, _ = asyncio.run(load_tool_module_by_id(tool_id, content=content))
    return tool


def test_every_import_form_of_the_old_package_loads():
    tool = _load(OLD_STYLE_TOOL)
    import local_llm.models.users

    assert tool.misc is local_llm.utils.misc
    assert tool.users_module is local_llm.models.users
    assert tool.users_by_name is local_llm.models.users
    assert tool.names == (
        env.LLLM_NAME,
        '',
        env.SERVER_DIR,
        env.PACKAGE_DIR,
        env.LLLM_SECRET_KEY,
        config.WEBUI_URL,
        '',
    )


def test_the_alias_is_the_real_module_not_a_second_copy():
    import open_webui.utils.misc

    assert sys.modules['open_webui.utils.misc'] is local_llm.utils.misc
    assert open_webui.utils.misc is local_llm.utils.misc
    assert local_llm.utils.misc.__spec__.name == 'local_llm.utils.misc'
    assert local_llm.utils.misc.__name__ == 'local_llm.utils.misc'


def test_a_name_that_never_existed_still_fails_to_import():
    with pytest.raises(ImportError):
        _load('from open_webui.env import WEBUI_NO_SUCH_SETTING\nclass Tools: pass\n', 'missing')
    with pytest.raises(ImportError):
        _load('from open_webui.config import NO_SUCH_SETTING\nclass Tools: pass\n', 'missing')
    with pytest.raises(ModuleNotFoundError):
        _load('import open_webui.no_such_module\nclass Tools: pass\n', 'missing')


def test_source_is_not_rewritten_for_the_old_package():
    src = (
        'from open_webui.models.users import Users\n'
        "TYPE = 'open_webui:code_interpreter'\n"
        'from open_webui_extras import thing\n'
    )
    assert replace_imports(src) == src


def test_existing_bare_imports_still_map_into_the_package():
    assert replace_imports('from utils.misc import x\n') == 'from local_llm.utils.misc import x\n'
    assert replace_imports('from local_llm.utils import y\n') == 'from local_llm.utils import y\n'
