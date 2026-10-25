"""benchmarks/evaluation/grading/evalplus_runtime.py - the code a HumanEval+/MBPP+ grading program runs.

Not imported by the grader. evalplus.py reads this file as text and embeds it
in every grading program, followed by one call to main(), so the comparison
runs in the grading subprocess and never in the backend. It is also an
ordinary module, so the tests import it and check each piece directly.

That is why it is stdlib only: graded HumanEval+/MBPP+ programs run under
`python -I -S`, with no site-packages, so it cannot use numpy. allclose() is
numpy's formula reimplemented for nested lists of numbers, and is tested
against numpy.allclose.

Ported from EvalPlus v0.3.1 (Apache-2.0, https://github.com/evalplus/evalplus;
see NOTICE). The pieces, and where each came from:

    MBPP_OUTPUT_*_TASKS, _surface_Area,
    _digit_distance_nums, _poly        evalplus/eval/_special_oracle.py
    mbpp_deserialize_inputs            evalplus/data/mbpp.py
    is_floats, check_output            evalplus/eval/__init__.py, unsafe_execute()
    expected outputs                   evalplus/gen/util/__init__.py, trusted_exec()
    MIN_TIME_LIMIT, TIME_LIMIT_FACTOR  evalplus/config.py
    sanitize, code_extract             evalplus/sanitize.py, on ast instead of tree-sitter

The oracles are copied as they are written there, quirks included, because a
score is only comparable to a published one if it is graded the same way:
Mbpp/164 (`are_equivalent`) passes on any output, task 115's empty item
deserializes to a dict, not a set, and once a float output has forced `atol`
to 1e-6 it stays 1e-6 for the rest of that input set. The one exception is
HumanEval/32 (`find_zero`): in EvalPlus its `continue` skips the progress
counter, so every answer fails; here a root within `atol` passes.

The answer is sanitized as EvalPlus sanitizes it before grading: its
imports, then the entry point and the top-level definitions it reaches,
nothing else. A model's own `assert`s and example calls never run, so a
correct function is not failed by a wrong self-test. EvalPlus parses with
tree-sitter, where a decorated function is a different node type that the
sanitizer does not keep; ast is used here, and decorated definitions are
dropped the same way.

What differs from EvalPlus, on purpose:

- The code sanitized is the block grading/__init__.py's extract_code() chose
  (the last fenced block with a def), not the longest syntactically valid
  run of lines in the whole reply, which is where EvalPlus starts.

- Expected outputs are computed in the grading run, from the canonical
  solution, rather than cached from an earlier one. Reference timing is then
  measured on this machine, under the same load as the candidate.
- The time limits come from the adapter's [check] (factor, floor, item cap),
  so changing them changes adapter_sha.
- The answer is called on deep copies of its inputs, so a mutating answer
  cannot change what the oracles see. EvalPlus passes them uncopied.
- EvalPlus's reliability_guard (which disables os and shutil functions) is
  not ported; the driver's isolation stands in for it.
- A failure is an exception whose last traceback line says which input set
  and input failed, and why. The driver prints the run's nonce only when
  grade() returns, so a candidate that exits early cannot pass.
"""

from __future__ import annotations

import ast
import cmath
import copy
import json
import math
import signal
import sys
import time
from typing import Any

# ---------------------------------------------------------------------------
# special oracles (evalplus/eval/_special_oracle.py)
# ---------------------------------------------------------------------------
# For tasks whose output are not serializable, we only check the output is not
# None, which is also consistent with the original dataset.
MBPP_OUTPUT_NOT_NONE_TASKS = ['check_str', 'text_match_three', 'text_starta_endb']

# Tasks that needs to perform set comparison over two lists
MBPP_OUTPUT_SET_EQ_TASKS = [
    'similar_elements',  # Mbpp/2
    'find_char_long',  # Mbpp/7
    'common_in_nested_lists',  # Mbpp/111
    'extract_singly',  # Mbpp/140
    'larg_nnum',  # Mbpp/232
    'intersection_array',  # Mbpp/249
    'find_dissimilar',  # Mbpp/579
    'Diff',  # Mbpp/769
]


# oracle for Mbpp/581
def _surface_Area(base_edge, height):
    """Recognizes the "height" as the perpendicular distance from the base to the apex of the pyramid."""
    slant_height = math.sqrt((base_edge / 2) ** 2 + height**2)
    base_area = base_edge**2
    lateral_area = 4 * (base_edge * slant_height) / 2
    total_surface_area = base_area + lateral_area
    return round(total_surface_area)


# oracle for Mbpp/558
def _digit_distance_nums(num1, num2):
    """Preprocesses the two numbers to have the same length by padding with zeros."""
    str_num1, str_num2 = str(num1), str(num2)
    max_length = max(len(str_num1), len(str_num2))
    str_num1, str_num2 = str_num1.zfill(max_length), str_num2.zfill(max_length)
    total_difference = 0
    for digit1, digit2 in zip(str_num1, str_num2, strict=True):
        difference = abs(int(digit1) - int(digit2))
        total_difference += difference
    return total_difference


# oracle for HumanEval/032
def _poly(xs: list, x: float):
    """Evaluates polynomial with coefficients xs at point x."""
    return sum([coeff * math.pow(x, i) for i, coeff in enumerate(xs)])


# ---------------------------------------------------------------------------
# MBPP+ inputs (evalplus/data/mbpp.py)
#
# The inputs are stored as JSON, so every tuple arrives as a list. These tasks
# need them back as tuples (Mbpp/2's contract asserts isinstance(..., tuple)),
# sets, complex numbers or dicts of tuples.
# ---------------------------------------------------------------------------
def mbpp_deserialize_inputs(task: str, inputs: list) -> list:
    task_id = int(task.split('/')[-1])
    if task_id in [
        2,
        116,
        132,
        143,
        222,
        261,
        273,
        394,
        399,
        421,
        424,
        429,
        470,
        560,
        579,
        596,
        616,
        630,
        726,
        740,
        744,
        809,
    ]:
        modified_inputs = [[tuple(lst) for lst in inp] for inp in inputs]

    elif task_id in [63, 64, 70, 94, 120, 237, 272, 299, 400, 409, 417, 438, 473, 614, 780]:
        modified_inputs = [[[tuple(lst) for lst in lst_lst] for lst_lst in inp] for inp in inputs]

    elif task_id in [75, 413, 444, 753]:
        modified_inputs = [[[tuple(lst) for lst in inp[0]]] + [inp[1]] for inp in inputs]

    elif task_id == 106 or task_id == 750:
        modified_inputs = [[inp[0]] + [tuple(inp[1])] for inp in inputs]

    elif task_id == 115:
        modified_inputs = [
            [[set(item) if isinstance(item, list) and len(item) else {} for item in inp[0]]] for inp in inputs
        ]

    elif task_id == 124:
        modified_inputs = [(float(inp[0]), complex(inp[1])) for inp in inputs]

    elif task_id in [250, 405, 446, 617, 720, 763, 808]:
        modified_inputs = [[tuple(inp[0])] + [inp[1]] for inp in inputs]

    elif task_id in [259, 401, 445]:
        modified_inputs = [[[tuple(lst) for lst in lst_lst] for lst_lst in inp] for inp in inputs]
        modified_inputs = [[tuple(lst) for lst in inp] for inp in modified_inputs]

    elif task_id == 278:
        modified_inputs = [[[tuple(item) if isinstance(item, list) else item for item in inp[0]]] for inp in inputs]
        modified_inputs = [[tuple(lst) for lst in inp] for inp in modified_inputs]

    elif task_id == 307:
        modified_inputs = [[tuple(inp[0])] + [inp[1], inp[2]] for inp in inputs]

    elif task_id == 722:
        modified_inputs = [[{key: tuple(value) for key, value in inp[0].items()}] + inp[1:] for inp in inputs]

    elif task_id == 252:
        modified_inputs = [[complex(inp[0])] for inp in inputs]

    elif task_id in [580, 615, 791]:

        def turn_all_list_into_tuple(inp):
            if isinstance(inp, list):
                return tuple([turn_all_list_into_tuple(item) for item in inp])
            return inp

        modified_inputs = [turn_all_list_into_tuple(inp) for inp in inputs]

    else:
        modified_inputs = inputs

    return modified_inputs


# ---------------------------------------------------------------------------
# comparison (evalplus/eval/__init__.py)
# ---------------------------------------------------------------------------
def is_floats(x) -> bool:
    # check if it is float; List[float]; Tuple[float]
    if isinstance(x, float):
        return True
    if isinstance(x, (list, tuple)) and x:
        return all(isinstance(i, float) for i in x)
    return False


# numpy stores a Python int it cannot fit in int64 as an object, and isclose
# then raises on it; so does this.
_INT64 = 2**63


def _number(x) -> complex | float:
    if isinstance(x, bool):
        return float(x)
    if isinstance(x, int):
        if abs(x) >= _INT64:
            raise TypeError('an integer too large for numpy to compare')
        return float(x)
    if isinstance(x, (float, complex)):
        return x
    raise TypeError(f'{type(x).__name__} is not a number')


def _shape(x) -> tuple[int, ...]:
    """The array shape numpy would give x, refusing what numpy would refuse."""
    if isinstance(x, (list, tuple)):
        shapes = [_shape(e) for e in x]
        if any(s != shapes[0] for s in shapes[1:]):
            raise ValueError('a ragged nested sequence')
        return (len(x), *(shapes[0] if shapes else ()))
    _number(x)
    return ()


def _flat(x) -> list:
    if isinstance(x, (list, tuple)):
        return [v for e in x for v in _flat(e)]
    return [_number(x)]


def _broadcast(a: tuple[int, ...], b: tuple[int, ...]) -> tuple[int, ...]:
    out = []
    for i in range(max(len(a), len(b))):
        da = a[len(a) - 1 - i] if i < len(a) else 1
        db = b[len(b) - 1 - i] if i < len(b) else 1
        if da != db and 1 not in (da, db):
            raise ValueError(f'shapes {a} and {b} do not broadcast')
        out.append(db if da == 1 else da)
    return tuple(reversed(out))


def _index(flat: list, shape: tuple[int, ...], target: tuple[int, ...], pos: tuple[int, ...]):
    """flat[...] at broadcast position pos of target, for an array of this shape."""
    offset = len(target) - len(shape)
    idx = 0
    for dim, size in enumerate(shape):
        idx = idx * size + (0 if size == 1 else pos[offset + dim])
    return flat[idx]


def _isfinite(x) -> bool:
    return cmath.isfinite(x) if isinstance(x, complex) else math.isfinite(x)


def _isclose(x, y, rtol: float, atol: float) -> bool:
    # numpy.isclose with equal_nan=False: finite values by the asymmetric
    # formula below, infinities only when equal, NaN never.
    if _isfinite(x) and _isfinite(y):
        return abs(x - y) <= atol + rtol * abs(y)
    return x == y


def allclose(a, b, rtol: float = 1e-05, atol: float = 1e-08) -> bool:
    """numpy.allclose(a, b, rtol, atol) for numbers and nested lists or tuples of them.

    Raises where numpy raises (strings, None, ragged nesting, shapes that do
    not broadcast), which check_output() counts as a mismatch, as EvalPlus
    does.
    """
    sa, sb = _shape(a), _shape(b)
    target = _broadcast(sa, sb)
    fa, fb = _flat(a), _flat(b)
    total = 1
    for size in target:
        total *= size
    for n in range(total):
        pos = []
        rest = n
        for size in reversed(target):
            pos.append(rest % size)
            rest //= size
        pos = tuple(reversed(pos))
        if not _isclose(_index(fa, sa, target, pos), _index(fb, sb, target, pos), rtol, atol):
            return False
    return True


def check_output(dataset: str, entry_point: str, inp: Any, out: Any, exp: Any, atol: float) -> tuple[bool, float]:
    """Whether out matches exp on input inp, and the atol for the next input.

    unsafe_execute()'s loop body: an exception anywhere in here is a mismatch,
    and atol comes back changed once a float output has forced it to 1e-6.
    """
    try:
        exact_match = out == exp

        # ================================================ #
        # ============== special oracles ================= #
        if dataset == 'mbpp':
            if 'are_equivalent' == entry_point:  # Mbpp/164 special oracle
                exact_match = exact_match or True
            elif 'sum_div' == entry_point:  # Mbpp/295 special oracle
                exact_match = exact_match or out == 0
            elif 'surface_Area' == entry_point:  # Mbpp/581 special oracle
                exact_match = exact_match or abs(out - _surface_Area(*inp)) <= atol
            elif 'digit_distance_nums' == entry_point:  # Mbpp/558 special oracle
                exact_match = exact_match or out == _digit_distance_nums(*inp)
            elif entry_point in MBPP_OUTPUT_SET_EQ_TASKS:
                exact_match = set(out) == set(exp)
            elif entry_point in MBPP_OUTPUT_NOT_NONE_TASKS:
                # exp is True  if not None
                #        False if None
                if isinstance(out, bool):
                    exact_match = out == exp
                else:
                    exact_match = exp == (out is not None)

        if dataset == 'humaneval':
            if 'find_zero' == entry_point:
                # _poly(*inp, out), as EvalPlus writes it; inp is [xs].
                poly: Any = _poly
                return bool(abs(poly(*inp, out)) <= atol), atol
        # ============== special oracles ================= #
        # ================================================ #

        if atol == 0 and is_floats(exp):
            atol = 1e-6  # enforce atol for float comparison
        if not exact_match and atol != 0:
            # explicitly set rtol=1e-07
            # to match `np.testing.assert_allclose`'s default values
            if type(out) is not type(exp):
                return False, atol
            if isinstance(exp, (list, tuple)) and isinstance(out, (list, tuple)) and len(out) != len(exp):
                return False, atol
            return bool(allclose(out, exp, rtol=1e-07, atol=atol)), atol
        return bool(exact_match), atol
    except Exception:
        return False, atol


# ---------------------------------------------------------------------------
# answer sanitizing (evalplus/sanitize.py)
# ---------------------------------------------------------------------------
# code_extract() tries every run of lines, so it is bounded: a reply longer
# than this is graded as it is when it does not parse whole.
_EXTRACT_MAX_LINES = 300


def _parses(code: str) -> bool:
    try:
        ast.parse(code)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return False
    return True


def code_extract(text: str) -> str:
    """The longest run of lines that parses, counting non-blank lines."""
    if _parses(text):
        return text
    lines = text.split('\n')
    if len(lines) > _EXTRACT_MAX_LINES:
        return text
    longest_line_pair = (0, 0)
    longest_so_far = 0
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            current_lines = '\n'.join(lines[i : j + 1])
            if _parses(current_lines):
                current_length = sum(1 for line in lines[i : j + 1] if line.strip())
                if current_length > longest_so_far:
                    longest_so_far = current_length
                    longest_line_pair = (i, j)
    return '\n'.join(lines[longest_line_pair[0] : longest_line_pair[1] + 1])


def _identifiers(node: ast.AST) -> set[str]:
    """Every name a definition mentions: tree-sitter's identifier nodes, as ast spells them."""
    names: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            names.add(sub.id)
        elif isinstance(sub, ast.Attribute):
            names.add(sub.attr)
        elif isinstance(sub, ast.arg):
            names.add(sub.arg)
        elif isinstance(sub, ast.keyword) and sub.arg:
            names.add(sub.arg)
        elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(sub.name)
        elif isinstance(sub, ast.alias):
            names.add((sub.asname or sub.name).split('.')[0])
        elif isinstance(sub, (ast.Global, ast.Nonlocal)):
            names.update(sub.names)
    return names


def _has_return(node: ast.AST) -> bool:
    return any(isinstance(sub, ast.Return) for sub in ast.walk(node))


def _assigned_name(node: ast.Assign | ast.AnnAssign):
    target = node.targets[0] if isinstance(node, ast.Assign) else node.target
    return target.id if isinstance(target, ast.Name) else None


def extract_target_code_or_empty(code: str, entrypoint: str | None = None) -> str:
    code = code_extract(code)
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return ''
    class_names: set = set()
    function_names: set = set()
    variable_names: set = set()
    import_nodes: list[ast.stmt] = []
    definition_nodes: list[tuple] = []

    def seen(name) -> bool:
        return name in class_names or name in variable_names or name in function_names

    # The first definition of a name wins, as in EvalPlus.
    for child in tree.body:
        if isinstance(child, (ast.Import, ast.ImportFrom)):
            import_nodes.append(child)
        elif isinstance(child, ast.ClassDef) and not child.decorator_list:
            if not seen(child.name):
                definition_nodes.append((child.name, child))
                class_names.add(child.name)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and not child.decorator_list:
            if not seen(child.name) and _has_return(child):
                definition_nodes.append((child.name, child))
                function_names.add(child.name)
        elif isinstance(child, (ast.Assign, ast.AnnAssign)):
            name = _assigned_name(child)
            if not seen(name):
                definition_nodes.append((name, child))
                variable_names.add(name)

    reachable: set = set()
    if entrypoint:
        name2deps = {name: _identifiers(node) for name, node in definition_nodes}
        queue, reachable = [entrypoint], {entrypoint}
        while queue:
            current = queue.pop(0)
            for neighbour in name2deps.get(current, ()):
                if neighbour not in reachable:
                    reachable.add(neighbour)
                    queue.append(neighbour)

    parts = [ast.get_source_segment(code, node) or '' for node in import_nodes]
    for name, node in definition_nodes:
        if entrypoint and name not in reachable:
            continue
        parts.append(ast.get_source_segment(code, node) or '')
    return '\n'.join(parts)


def sanitize(code: str, entrypoint: str | None = None) -> str:
    sanitized_code = extract_target_code_or_empty(code, entrypoint).strip()
    if not sanitized_code:
        return code_extract(code)
    return sanitized_code


# ---------------------------------------------------------------------------
# running one item
# ---------------------------------------------------------------------------
# evalplus/config.py, the defaults the adapters' [check] repeats.
MIN_TIME_LIMIT = 1.0
TIME_LIMIT_FACTOR = 4.0
SANITIZE_SECONDS = 10.0


class GradeTimeout(BaseException):
    """An input, or the item as a whole, ran past its time limit.

    A BaseException, so a candidate's `except Exception:` does not swallow
    the alarm and carry on. The grader reads the class name on the last
    traceback line as fail_timeout.
    """


class CandidateError(Exception):
    """The answer did not load, define the function, or return on some input."""


class ReferenceFailed(Exception):
    """The dataset's own solution failed: a grading problem, not the model's.

    Selfcheck runs the reference as the candidate, so an item whose reference
    fails here is calibrated out as ungradeable before any model sees it.
    """


class _Sink:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def _on_alarm(signum, frame):
    raise GradeTimeout()


def _short(value) -> str:
    try:
        text = repr(value)
    except Exception as exc:  # a candidate's own __repr__ can raise
        text = f'<unrepresentable {type(value).__name__}: {exc}>'
    return _clip(text)


def _clip(text: str) -> str:
    # One line, and short: the grader reports the traceback's last line.
    text = ' '.join(text.split())
    return text if len(text) <= 120 else text[:117] + '...'


def _why(exc: BaseException) -> str:
    if isinstance(exc, SystemExit):
        # The driver's wording for the same thing, so every harness reports it alike.
        return f'SystemExit: the program exited ({exc.code!r}) before its tests finished'
    try:
        detail = str(exc)
    except Exception:
        detail = ''
    return f'{type(exc).__name__}: {_clip(detail)}' if detail else type(exc).__name__


def _call(fn, args, seconds: float):
    """fn(*args) under an alarm of `seconds`, with the candidate's printing discarded."""
    stdout, stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = _Sink()
    try:
        signal.setitimer(signal.ITIMER_REAL, max(seconds, 1e-3))
        try:
            return fn(*args)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        sys.stdout, sys.stderr = stdout, stderr


def _load(source: str, name: str, entry_point: str, seconds: float):
    namespace = {'__name__': name}
    code = compile(source, f'<{name}>', 'exec', dont_inherit=True)
    _call(exec, (code, namespace), seconds)
    fn = namespace.get(entry_point)
    if not callable(fn):
        raise CandidateError(f'the answer defines no function named {entry_point}')
    return fn


def _limit_memory(limit: int) -> None:
    # EvalPlus caps each run's address space at 4 GiB; so does this, which
    # also keeps a runaway answer from pushing a served model's experts out of
    # RAM. Best effort: some platforms refuse it.
    try:
        import resource

        _, hard = resource.getrlimit(resource.RLIMIT_AS)
        if hard != resource.RLIM_INFINITY:
            limit = min(limit, hard)
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
    except (ImportError, ValueError, OSError):
        pass


def expected_outputs(fn, inputs: list, output_not_none: bool) -> tuple[list, list[float]]:
    """trusted_exec(): the reference's outputs on deep copies of the inputs, and how long each took."""
    outputs, times = [], []
    for inp in inputs:
        arg = copy.deepcopy(inp)
        start = time.perf_counter()
        outputs.append(fn(*arg))
        times.append(time.perf_counter() - start)
    if output_not_none:
        outputs = [o is not None for o in outputs]
    return outputs, times


def grade(spec: dict, candidate: str, reference: str) -> None:
    """Grade one answer: return when every base and plus input matches, raise otherwise.

    spec holds the item (dataset, task_id, entry_point, atol, base_input,
    plus_input) and the adapter's limits (min_time_limit, time_limit_factor,
    cap, memory_limit_bytes). The cap covers the whole item, the reference
    included: the candidate gets what is left of it, or the sum of its
    per-input limits if that is less.
    """
    start = time.perf_counter()
    cap = float(spec['cap'])
    _limit_memory(int(spec['memory_limit_bytes']))
    signal.signal(signal.SIGALRM, _on_alarm)

    dataset, task_id, entry = spec['dataset'], spec['task_id'], spec['entry_point']
    # Sanitized before anything runs. Parsing is bounded too: a reply that
    # takes longer than this to sanitize is graded as it was written.
    try:
        candidate = _call(sanitize, (candidate, entry), SANITIZE_SECONDS)
    except GradeTimeout:
        pass
    sets = [('base', spec['base_input']), ('plus', spec['plus_input'])]
    if dataset == 'mbpp':
        sets = [(name, mbpp_deserialize_inputs(task_id, inputs)) for name, inputs in sets]
    output_not_none = dataset == 'mbpp' and entry in MBPP_OUTPUT_NOT_NONE_TASKS

    # Every expected output is computed before the candidate's code exists in
    # this process, so nothing it does can reach the reference.
    try:
        ref_fn = _load(reference, 'reference', entry, cap)
        expected = {}
        for name, inputs in sets:
            left = cap - (time.perf_counter() - start)
            expected[name] = _call(expected_outputs, (ref_fn, inputs, output_not_none), left)
    except GradeTimeout:
        raise ReferenceFailed(f'the reference solution took longer than the item cap of {cap:g} s') from None
    except BaseException as exc:
        raise ReferenceFailed(f'the reference solution failed: {_why(exc)}') from None

    # Bound before the candidate exists, and the module taken out of
    # sys.modules, so an answer cannot swap the comparison by patching this
    # module's globals. That closes the obvious route, not every route: like
    # every harness here, this is process isolation for model output, not a
    # sandbox against an adversary (see grading/__init__.py).
    compare, call, deepcopy, clock = check_output, _call, copy.deepcopy, time.perf_counter
    sys.modules.pop('__graded__', None)

    floor, factor = float(spec['min_time_limit']), float(spec['time_limit_factor'])
    limits = {name: [max(floor, factor * t) for t in expected[name][1]] for name, _ in sets}
    budget = min(cap - (clock() - start), sum(sum(v) for v in limits.values()))
    deadline = clock() + budget

    def remaining() -> float:
        return deadline - clock()

    try:
        fn = _load(candidate, 'solution', entry, remaining())
    except GradeTimeout:
        raise GradeTimeout(f'the answer did not finish loading within the item budget of {budget:.1f} s') from None
    except CandidateError:
        raise
    except BaseException as exc:
        raise CandidateError(f'the answer did not load: {_why(exc)}') from None

    for name, inputs in sets:
        outputs, ref_times = expected[name]
        atol = spec['atol']  # per input set, as EvalPlus checks base and plus separately
        for i, inp in enumerate(inputs):
            limit = limits[name][i]
            left = remaining()
            if left <= 0:
                raise GradeTimeout(f'{name} input {i}: the item budget of {budget:.1f} s ran out')
            seconds = min(limit, left)
            began = clock()
            try:
                out = call(fn, deepcopy(inp), seconds)
            except GradeTimeout:
                if seconds < limit:
                    raise GradeTimeout(f'{name} input {i}: the item budget of {budget:.1f} s ran out') from None
                raise GradeTimeout(
                    f'{name} input {i} ran past its {seconds:.2f} s limit (the reference took {ref_times[i]:.4f} s)'
                ) from None
            except BaseException as exc:
                raise CandidateError(f'{name} input {i}: {_why(exc)}') from None
            if clock() - began > seconds:
                # The alarm fired and the answer caught it.
                raise GradeTimeout(f'{name} input {i} ran past its {seconds:.2f} s limit') from None
            try:
                ok, atol = call(compare, (dataset, entry, inp, out, outputs[i], atol), max(remaining(), 1.0))
            except GradeTimeout:
                raise GradeTimeout(f'{name} input {i}: comparing the output ran out of time') from None
            if not ok:
                raise AssertionError(f'{name} input {i}: expected {_short(outputs[i])}, got {_short(out)}')


def main(spec_json: str, candidate: str, reference: str) -> None:
    grade(json.loads(spec_json), candidate, reference)
