"""Graded code gets no stdin and none of the backend's environment.

Run from apps/server:

    python -m pytest tests/test_grader_isolation.py
"""

from __future__ import annotations

from local_llm.benchmarks.evaluation.grading import FAIL_ERROR, PASS, run_program


def test_graded_code_cannot_read_stdin():
    outcome, reason = run_program('input()\n', timeout=20, isolated=True)
    assert outcome == FAIL_ERROR and 'EOFError' in reason


def test_graded_code_cannot_see_the_backends_secrets(monkeypatch):
    monkeypatch.setenv('DATABASE_URL', 'postgresql://user:secret@db/x')
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-secret')
    program = (
        'import os\n'
        "assert 'DATABASE_URL' not in os.environ, 'database url leaked'\n"
        "assert 'OPENAI_API_KEY' not in os.environ, 'api key leaked'\n"
        "assert os.environ['HOME'] == os.getcwd()\n"
    )
    assert run_program(program, timeout=20, isolated=True) == (PASS, '')
