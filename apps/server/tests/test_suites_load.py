"""load_suite() accepts only the suites its directory lists.

Run from apps/server:

    python -m pytest tests/test_suites_load.py
"""

from __future__ import annotations

import pytest

from local_llm.benchmarks.evaluation.suites import load_suite, suite_names


def test_known_suites_load():
    assert {'smoke', 'standard', 'full'} <= set(suite_names())
    assert load_suite('smoke')['id'] == 'smoke'


@pytest.mark.parametrize('name', ['../adapters/ds1000', '../../../pyproject', '/etc/passwd', 'nope'])
def test_anything_else_is_refused(name):
    with pytest.raises(SystemExit, match='no suite'):
        load_suite(name)
