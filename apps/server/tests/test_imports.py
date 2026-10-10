"""The backend still imports as a whole, not just the modules the other tests touch.

Added after a lint autofix removed an "unused" import from config.py that
main.py and routers/chats.py imported *through* it (ENABLE_ADMIN_CHAT_ACCESS,
defined in env.py). Every other test passed; the app failed to start.
"""

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]  # apps/server/
PACKAGE = SERVER_DIR / 'open_webui'


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(SERVER_DIR).with_suffix('').parts)
    if parts[-1] == '__init__':
        parts = parts[:-1]
    return '.'.join(parts)


def _top_level_names(tree: ast.Module) -> tuple[set[str], bool]:
    """Names a module binds at import time, and whether it has a `*` import."""
    names: set[str] = set()
    star = False

    def visit(body: list[ast.stmt]) -> None:
        nonlocal star
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    names.update(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
            elif isinstance(node, ast.Import):
                names.update((a.asname or a.name).split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == '*':
                        star = True
                    else:
                        names.add(alias.asname or alias.name)
            elif isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                for field in ('body', 'orelse', 'finalbody'):
                    visit(getattr(node, field, None) or [])
                for handler in getattr(node, 'handlers', []):
                    visit(handler.body)

    visit(tree.body)
    return names, star


def test_every_internal_from_import_resolves():
    files = [p for p in PACKAGE.rglob('*.py') if '__pycache__' not in p.parts]
    trees = {p: ast.parse(p.read_text(), filename=str(p)) for p in files}
    modules = {_module_name(p): p for p in files}
    bound = {p: _top_level_names(t) for p, t in trees.items()}

    missing = []
    for path, tree in trees.items():
        for node in ast.walk(tree):
            if not (isinstance(node, ast.ImportFrom) and node.level == 0 and node.module in modules):
                continue
            names, star = bound[modules[node.module]]
            for alias in node.names:
                if alias.name == '*' or star or alias.name in names or f'{node.module}.{alias.name}' in modules:
                    continue
                missing.append(f'{path.relative_to(SERVER_DIR)}:{node.lineno}: from {node.module} import {alias.name}')
    assert not missing, '\n'.join(missing)


def test_the_app_imports(tmp_path):
    # Importing open_webui.main sets up the database and connects the default
    # vector store, pgvector, so this needs a Postgres with the vector
    # extension. It runs migrations there: point TEST_DATABASE_URL at a
    # throwaway database, never the one `make backend` uses. CI provides one
    # (ci.yml's postgres service) and fails rather than skips without it.
    database_url = os.environ.get('TEST_DATABASE_URL')
    if not database_url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    # In a subprocess, with its own DATA_DIR, so the import's side effects
    # (data directories, app state) stay out of this test process.
    env = {
        **os.environ,
        'DATA_DIR': str(tmp_path),
        'DATABASE_URL': database_url,
        'VECTOR_DB': 'pgvector',
        'HF_HUB_OFFLINE': '1',
    }
    result = subprocess.run(
        [sys.executable, '-c', 'import open_webui.main'],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]
