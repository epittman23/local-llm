"""benchmarks/evaluation/grading/evalplus.py - the HumanEval+ and MBPP+ harness.

EvalPlus (Liu et al. 2023, arXiv:2305.01210) keeps each original problem and
adds far more inputs: HumanEval+ has a median of 973 per task, MBPP+ 105. The
dataset ships the inputs but not the outputs. Each expected output comes from
running the canonical solution on the input, and a candidate passes only when
it matches on every base input and every plus input.

The program this module builds is evalplus_runtime.py's source, followed by a
call to its main() with the item, the answer and the canonical solution as
literals. It runs like every other grading program, under the driver in
grading/__init__.py: in a subprocess, with -I -S, stdin from /dev/null, and
the nonce printed only after main() returns. This module only arranges for the
dataset's own verdict to be reached; it never states an answer.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

NAME = 'evalplus'
WANT_DEF = True

RUNTIME = Path(__file__).with_name('evalplus_runtime.py').read_text()

# Seconds the subprocess gets beyond the item cap, to start Python and parse
# the program, whose inputs can run to 200 KB of JSON.
STARTUP_SECONDS = 5


def subprocess_timeout(check: dict) -> int:
    """The grading subprocess's deadline: the item cap, which the program enforces itself, plus start-up."""
    return int(check['cap']) + STARTUP_SECONDS


def reference_source(item: dict) -> str:
    # What EvalPlus runs to compute expected outputs: prompt + canonical_solution.
    return item['prompt'] + item['canonical_solution']


def build_program(item: dict, code: str, check: dict) -> str | None:
    """The full program to execute, or None when the answer has no usable code."""
    if not code.strip():
        return None
    entry = item['entry_point']
    # HumanEval+ prompts are a stub to complete. A model that returned only a
    # body, the completion-style answer the stub invites, gets the stub
    # prepended so that answer is graded rather than discarded. MBPP+ prompts
    # are prose in a docstring, with nothing to prepend.
    if check['dataset'] == 'humaneval' and not re.search(rf'^\s*(async\s+)?def\s+{re.escape(entry)}\b', code, re.M):
        code = item['prompt'] + '\n' + code
    spec = {
        'dataset': check['dataset'],
        'task_id': item['task_id'],
        'entry_point': entry,
        'atol': item['atol'],
        'base_input': item['base_input'],
        'plus_input': item['plus_input'],
        'min_time_limit': check['min_time_limit'],
        'time_limit_factor': check['time_limit_factor'],
        'cap': check['cap'],
        'memory_limit_bytes': int(check['memory_limit_gib'] * 2**30),
    }
    # repr() gives a Python literal that round-trips any string exactly; the
    # spec's JSON is ASCII, so its literal is too.
    call = f'main({json.dumps(spec)!r}, {code!r}, {reference_source(item)!r})'
    return RUNTIME + '\n\n' + call + '\n'


def reference_answer(item: dict) -> str | None:
    """The dataset's own solution, dressed as if a model had answered it."""
    body = item.get('canonical_solution')
    return f'```python\n{reference_source(item)}\n```\n' if body else None
