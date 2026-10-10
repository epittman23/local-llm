"""The Benchmarks section's version-controlled config resolves from every subpackage.

The modules that read benchmarks/data/ live one level below it (evaluation/,
tuning/), so each used to compute the path from its own location; one constant
in benchmarks/paths.py replaced that. These pin that every directory exists and
holds the files the readers expect.
"""

from local_llm.benchmarks import paths


def test_every_data_dir_exists_and_is_not_empty():
    for d in (paths.ADAPTERS_DIR, paths.SUITES_DIR, paths.GRID_DIR, paths.PROMPTS_DIR):
        assert d.is_dir(), d
        assert any(d.iterdir()), d


def test_data_dir_is_inside_the_benchmarks_package():
    assert paths.BENCHMARK_DATA_DIR.parent.name == 'benchmarks'
    assert (paths.BENCHMARK_DATA_DIR / 'adapters' / 'humaneval.toml').is_file()
    assert (paths.BENCHMARK_DATA_DIR / 'prompts' / 'assistant.txt').is_file()
