"""A plugin's legacy imports are rewritten only where they are imports (#269).

`replace_imports` maps the oldest plugin import style (`from utils...`,
`from apps...`, `from main...`, `from config...`) into this package. It
did so by plain substring replacement, so `from configparser import X`
became `from local_llm.configparser import X`, `from mainframe` and
`from utils_extra` were corrupted the same way, and so was any docstring or
string that contained the text. The corrupted source was then saved, and a
tool or function that had worked failed to load with ModuleNotFoundError.
Now only real `from <root>` import statements whose module is exactly one of
those roots, or inside one, are rewritten; everything else is left as it
was written, and source that does not parse is not touched.

Run from apps/server:

    python -m pytest tests/test_plugin_import_rewrite.py
"""

from __future__ import annotations

import pytest

from local_llm.utils.plugin import replace_imports


@pytest.mark.parametrize(
    'src',
    [
        'from configparser import ConfigParser\n',
        'from mainframe import run\n',
        'from utils_extra import helper\n',
        'from apps_sdk.client import Client\n',
        'import config\n',
        '"""Example:\n\n    from config import X\n"""\n',
        "HELP = 'from utils import y'\n",
        '# from main import app\n',
        'from local_llm.config import WEBUI_NAME\n',
        'from . import config\n',
        'from .utils import helper\n',
    ],
)
def test_anything_but_a_legacy_import_is_left_as_written(src):
    assert replace_imports(src) == src


@pytest.mark.parametrize(
    ('src', 'expected'),
    [
        ('from config import X\n', 'from local_llm.config import X\n'),
        ('from utils.misc import y\n', 'from local_llm.utils.misc import y\n'),
        ('from main import app\n', 'from local_llm.main import app\n'),
        ('from apps.webui import z\n', 'from local_llm.apps.webui import z\n'),
        (
            'def f():\n    from utils.misc import y\n    return y\n',
            'def f():\n    from local_llm.utils.misc import y\n    return y\n',
        ),
        ('x = 1; from config import X\n', 'x = 1; from local_llm.config import X\n'),
        ("n = 'Zoë'; from config import X\n", "n = 'Zoë'; from local_llm.config import X\n"),
        ('from  config  import X\n', 'from  local_llm.config  import X\n'),
        ('from config import (\n    A,\n    B,\n)\n', 'from local_llm.config import (\n    A,\n    B,\n)\n'),
    ],
)
def test_a_legacy_import_is_mapped_into_the_package(src, expected):
    assert replace_imports(src) == expected


def test_a_tool_with_both_keeps_its_other_imports():
    src = (
        '"""A tool.\n\nfrom config import nothing: this line is prose.\n"""\n'
        'from configparser import ConfigParser\n'
        'from config import WEBUI_NAME\n'
        "LABEL = 'from main import app'\n"
    )

    assert replace_imports(src) == (
        '"""A tool.\n\nfrom config import nothing: this line is prose.\n"""\n'
        'from configparser import ConfigParser\n'
        'from local_llm.config import WEBUI_NAME\n'
        "LABEL = 'from main import app'\n"
    )


def test_source_that_does_not_parse_is_left_alone():
    src = 'from configparser import ConfigParser\nfrom config import (\n'

    assert replace_imports(src) == src


def test_a_rewritten_tool_still_imports():
    namespace: dict = {}
    exec(
        compile(replace_imports('from configparser import ConfigParser\nfrom config import ENV\n'), 't', 'exec'),
        namespace,
    )

    assert namespace['ConfigParser'].__module__ == 'configparser'
    assert 'ENV' in namespace
