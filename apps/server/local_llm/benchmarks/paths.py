"""Where the Benchmarks section's version-controlled config lives.

`data/` (adapter and suite TOMLs, tuning grids, system prompts) sits beside
this file at the top of the benchmarks package, while the modules that read it
live in the serving/, evaluation/, analysis/ and tuning/ subpackages. One
constant here instead of each module computing `Path(__file__).parent / 'data'`
from its own depth, which silently breaks the moment a module moves.

Fetched datasets, answer exports and reports are runtime data and live under
the app's DATA_DIR instead (see evaluation/datasets.py).
"""

from pathlib import Path

BENCHMARK_DATA_DIR = Path(__file__).resolve().parent / 'data'
ADAPTERS_DIR = BENCHMARK_DATA_DIR / 'adapters'
SUITES_DIR = BENCHMARK_DATA_DIR / 'suites'
GRID_DIR = BENCHMARK_DATA_DIR / 'tuning'
PROMPTS_DIR = BENCHMARK_DATA_DIR / 'prompts'
