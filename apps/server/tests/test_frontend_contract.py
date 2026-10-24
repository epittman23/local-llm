"""Every backend URL the frontend calls is a route the backend serves.

The Playwright suite mocks the backend, and its mocks follow the frontend's
API client, so a backend route renamed, removed or given another method
leaves both suites green while the real app breaks. This reads every
`fetch(...)` in apps/web/src (tests excluded) whose URL starts at one of
the backend's base paths (`lib/constants.ts`), and checks its method and
path against the app's own route table.

URLs it cannot resolve statically (a URL in a variable, an external server
such as a terminal or a direct OpenAI connection) are left out, and the
test fails if their count grows past UNRESOLVED_LIMIT, so new calls keep
being checked.
"""

import re
from pathlib import Path

import pytest

WEB_SRC = Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src'

# fetch() calls whose URL isn't a literal template on a backend base
# (2026-10-23: 38, mostly terminal servers and direct OpenAI connections).
# Raise it only for calls to servers other than this backend.
UNRESOLVED_LIMIT = 38

KNOWN_METHODS = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE'}


def _matching(src: str, start: int, open_ch: str, close_ch: str) -> int:
    """Index just past the bracket that closes the one opened at src[start - 1]."""
    depth, i = 1, start
    while i < len(src) and depth:
        ch = src[i]
        if ch in '\'"':
            i = _skip_string(src, i)
            continue
        if ch == '`':
            i = _skip_template(src, i)[0]
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
        i += 1
    return i


def _skip_string(src: str, i: int) -> int:
    quote, i = src[i], i + 1
    while i < len(src) and src[i] != quote:
        i += 2 if src[i] == '\\' else 1
    return i + 1


def _skip_template(src: str, i: int) -> tuple[int, list[str | tuple[str]]]:
    """Parse a template literal at src[i]; return the end and its parts.

    Text parts are str; each `${...}` is a 1-tuple holding its expression.
    """
    parts: list[str | tuple[str]] = []
    text, i = '', i + 1
    while i < len(src) and src[i] != '`':
        if src[i] == '\\':
            text += src[i : i + 2]
            i += 2
        elif src.startswith('${', i):
            parts.append(text)
            end = _matching(src, i + 2, '{', '}')
            parts.append((src[i + 2 : end - 1],))
            text, i = '', end
        else:
            text += src[i]
            i += 1
    parts.append(text)
    return i + 1, parts


def _literals(expression: str) -> list[str]:
    """String values an expression can take, as samples (`${...}` inside become x1)."""
    values = []
    i = 0
    while i < len(expression):
        ch = expression[i]
        if ch in '\'"':
            end = _skip_string(expression, i)
            values.append(expression[i + 1 : end - 1])
            i = end
        elif ch == '`':
            end, parts = _skip_template(expression, i)
            values.append(''.join(p if isinstance(p, str) else 'x1' for p in parts))
            i = end
        else:
            i += 1
    return values


def _samples(parts: list[str | tuple[str]]) -> list[str]:
    """Concrete paths the template can produce, query strings dropped."""
    outs = ['']
    for part in parts:
        if isinstance(part, str):
            outs = [o + part for o in outs]
            continue
        expression = part[0]
        if outs[0].endswith('/'):
            # A path parameter: one segment, or several for a {name:path} route.
            choices = ['x1', 'x1/x2']
        else:
            # Glued to text: a conditional suffix such as `${base ? '/base' : ''}`.
            choices = ['', 'x1', *_literals(expression)]
        outs = [o + c for o in outs for c in choices]
    return sorted({o.split('?')[0] for o in outs})


def _strip_comments(src: str) -> str:
    """Blank out // line comments and /* */ blocks, keeping offsets and line numbers."""
    src = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), src, flags=re.DOTALL)
    return re.sub(r'(?m)^(\s*)//.*$', lambda m: m.group(1), src)


def _helper_arguments(src: str, at: int, name: str) -> list[str] | None:
    """For a URL segment that is a parameter of the function around `at`, the
    string literals that function is called with, e.g. `testsRequest(token,
    'datasets')`; None when `name` isn't such a parameter."""
    helpers = list(re.finditer(r'const (\w+) = async \(([^)]*)\)', src[:at]))
    if not helpers:
        return None
    helper = helpers[-1]
    params = [re.split(r'[:=?]', p)[0].strip() for p in helper.group(2).split(',')]
    if name not in params:
        return None
    index = params.index(name)
    values = []
    for call in re.finditer(rf'\b{helper.group(1)}\(', src):
        end = _matching(src, call.end(), '(', ')')
        args = [a.strip() for a in re.split(r',(?![^(]*\))', src[call.end() : end - 1])]
        if index < len(args) and re.fullmatch(r"'[^']*'|\"[^\"]*\"", args[index]):
            values.append(args[index][1:-1])
    return values or None


def frontend_calls() -> tuple[list[tuple[str, list[str], str]], int]:
    constants = (WEB_SRC / 'lib' / 'constants.ts').read_text()
    bases = {'WEBUI_BASE_URL': ''}
    for name, value in re.findall(r'export const (\w+_URL) = `([^`]*)`;', constants):
        bases[name] = re.sub(r'\$\{(\w+)\}', lambda m: bases[m.group(1)], value)

    calls, unresolved = [], 0
    for path in sorted(WEB_SRC.rglob('*.ts*')):
        if '.test.' in path.name:
            continue
        src = _strip_comments(path.read_text())
        for match in re.finditer(r'\bfetch\(', src):
            end = _matching(src, match.end(), '(', ')')
            body = src[match.end() : end - 1]
            where = f'{path.relative_to(WEB_SRC)}:{src.count(chr(10), 0, match.start()) + 1}'
            first = body.lstrip()
            if not first.startswith('`'):
                unresolved += 1
                continue
            _, parts = _skip_template(first, 0)
            head = parts[1][0].strip() if len(parts) > 1 and parts[0] == '' else None
            if head in bases:
                parts = [bases[head] + parts[2], *parts[3:]]
            elif not (isinstance(parts[0], str) and parts[0].startswith('/')):
                unresolved += 1
                continue
            # A segment taken from the enclosing helper's parameter: check the
            # URL once per literal the helper is called with.
            expanded = [parts]
            for k, part in enumerate(parts):
                if isinstance(part, tuple) and re.fullmatch(r'\w+', part[0].strip()):
                    values = _helper_arguments(src, match.start(), part[0].strip())
                    if values:
                        expanded = [[*p[:k], v, *p[k + 1 :]] for p in expanded for v in values]
            method = re.search(r'\bmethod:\s*[\'"](\w+)[\'"]', body)
            if method:
                verb = method.group(1).upper()
            elif re.search(r'\bmethod\b', body):
                verb = '*'  # chosen at runtime
            else:
                verb = 'GET'
            calls.extend((verb, _samples(p), where) for p in expanded)
    return calls, unresolved


@pytest.fixture(scope='module')
def routes():
    import local_llm.main

    table = []
    for route in local_llm.main.app.routes:
        pattern = ''
        last = 0
        for m in re.finditer(r'\{(\w+)(:path)?\}', route.path):
            pattern += re.escape(route.path[last : m.start()]) + ('.+' if m.group(2) else '[^/]+')
            last = m.end()
        pattern = re.compile('^' + pattern + re.escape(route.path[last:]) + '$')
        methods = getattr(route, 'methods', None) or set()
        table.append((methods, pattern))
    return table


def test_the_parser_reads_nested_templates():
    src = "`${BASE}/api/models${base ? '/base' : ''}?${q}`"
    _, parts = _skip_template(src, 0)
    assert _samples(['/api/models', *parts[3:]]) == ['/api/models', '/api/models/base', '/api/modelsx1']


def test_every_frontend_call_has_a_backend_route(routes):
    calls, unresolved = frontend_calls()
    assert len(calls) > 400, f'only {len(calls)} calls found; is the parser still reading apps/web/src?'

    missing = []
    for verb, samples, where in calls:
        if not any(
            pattern.match(sample) and (verb == '*' or verb in methods)
            for sample in samples
            for methods, pattern in routes
        ):
            missing.append(f'{where}: {verb} {samples[0]}')
    assert not missing, 'frontend calls with no backend route:\n  ' + '\n  '.join(missing)

    assert unresolved <= UNRESOLVED_LIMIT, (
        f'{unresolved} fetch() calls whose URL this test cannot resolve (limit {UNRESOLVED_LIMIT}). '
        'Build backend URLs as `${WEBUI_API_BASE_URL}/...` template literals so they are checked.'
    )
