"""Stored or pasted plugin source that imports the package's old name still loads.

The package was renamed from open_webui to local_llm on 2026-10-10. Tool and
Function source in the database (and community plugins pasted in later)
imports `open_webui.*`; replace_imports rewrites it on load and on save, the
same mechanism that already maps bare `from utils` and friends.
"""

from local_llm.utils.plugin import replace_imports


def test_old_package_imports_are_rewritten():
    src = (
        'from open_webui.models.users import Users\n'
        'import open_webui.utils.misc as misc\n'
        'from open_webui import config\n'
        'from  open_webui.env import DATA_DIR\n'
    )
    assert replace_imports(src) == (
        'from local_llm.models.users import Users\n'
        'import local_llm.utils.misc as misc\n'
        'from local_llm import config\n'
        'from  local_llm.env import DATA_DIR\n'
    )


def test_protocol_strings_and_lookalike_names_are_left_alone():
    src = (
        "TYPE = 'open_webui:code_interpreter'\n"
        'required_open_webui_version = "0.11.3"\n'
        'from open_webui_extras import thing\n'
        '# see open_webui.main for context\n'
    )
    assert replace_imports(src) == src


def test_existing_bare_imports_still_map_into_the_package():
    assert replace_imports('from utils.misc import x\n') == 'from local_llm.utils.misc import x\n'
    assert replace_imports('from local_llm.utils import y\n') == 'from local_llm.utils import y\n'
