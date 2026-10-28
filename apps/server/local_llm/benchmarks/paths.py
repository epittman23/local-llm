"""Where the Benchmarks section's version-controlled config lives.

`data/` (adapter and suite TOMLs, vendored datasets, tuning and pre-screen
grids, system prompts) sits beside
this file at the top of the benchmarks package, while the modules that read it
live in the serving/, evaluation/, analysis/, tuning/ and prescreen/
subpackages. One
constant here instead of each module computing `Path(__file__).parent / 'data'`
from its own depth, which silently breaks the moment a module moves.

Fetched datasets, calibrations, answer exports and reports are runtime data
and live under the app's DATA_DIR instead (see evaluation/datasets.py).
"""

from pathlib import Path

BENCHMARK_DATA_DIR = Path(__file__).resolve().parent / 'data'
ADAPTERS_DIR = BENCHMARK_DATA_DIR / 'adapters'
DATASETS_DIR = BENCHMARK_DATA_DIR / 'datasets'
SUITES_DIR = BENCHMARK_DATA_DIR / 'suites'
GRID_DIR = BENCHMARK_DATA_DIR / 'tuning'
PRESCREEN_DIR = BENCHMARK_DATA_DIR / 'prescreen'
PROMPTS_DIR = BENCHMARK_DATA_DIR / 'prompts'
