"""The PR gate: title, attribution, and the tripwire on weakened CI gates.

Nobody reviews pull requests in this repo before they merge, so CI is the
only check on a change, and the same agent that writes a change could make
CI pass by weakening CI. The tripwire fails a pull request that changes a
gate (the workflows, lint and test configuration, the Makefile's checks) or
weakens the tests (skips, suppressions, deleted tests, edited golden files),
or that edits what AGENTS.md says is append-only (applied migrations,
benchmark prompts, decisions.md entries), until the repository owner
approves it.

    !!! NO AGENT MAY EVER BYPASS THIS TRIPWIRE WITHOUT FIRST ASKING THE   !!!
    !!! OWNER FOR EXPLICIT PERMISSION AND GIVING EXPLICIT REASONING FOR   !!!
    !!! THE BYPASS. See AGENTS.md, "The CI tripwire".                      !!!

Bypassing covers applying the approval label, merging around the check
(`gh pr merge --admin`, `bypass_rules`), editing, disabling or weakening
this script or its workflow, and taking the check off the ruleset.

Approval is both of: the `gate-change-approved` label, applied after the
latest push (a push removes it), and a `## Gate changes` section in the PR
body saying why each finding is needed. The body becomes the squash
commit's message, so the reasoning lands on main.

It runs from .github/workflows/pr-gate.yml under `pull_request_target`, so
the version on main judges every PR and a PR cannot edit its own judge. It
never runs code from the PR: it reads the PR's metadata, diff and a few
files through the REST API, as data. Locally, `python3
.github/scripts/pr_gate.py --pr N` runs the same checks read-only.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

APPROVAL_LABEL = 'gate-change-approved'
JUSTIFICATION_HEADING = re.compile(r'^##\s+Gate changes\s*$', re.MULTILINE | re.IGNORECASE)
MIN_JUSTIFICATION_CHARS = 40
DEPENDABOT = 'dependabot[bot]'

# Squash merges take the PR title as the commit subject, so the title is
# what has to be a conventional commit.
CONVENTIONAL_TITLE = re.compile(
    r'^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9./_,-]+\))?!?: \S'
)

# AGENTS.md's commit policy: no Claude co-author trailer or "Generated
# with" line, in commits or in the PR body (which becomes the commit body).
ATTRIBUTION = [
    re.compile(r'co-authored-by:[^\n]*(claude|anthropic)', re.IGNORECASE),
    re.compile(r'generated with \[?claude', re.IGNORECASE),
    re.compile(r'^claude-session:', re.IGNORECASE | re.MULTILINE),
    re.compile(r'noreply@anthropic\.com', re.IGNORECASE),
]

# Any change to these is a gate change.
PROTECTED_PATHS = [
    re.compile(p)
    for p in (
        r'^\.github/',  # workflows, this script, Dependabot
        r'^\.pre-commit-config\.yaml$',
        r'^\.gitleaksignore$',
        r'(^|/)\.gitignore$',  # ruff and Biome skip what git ignores
        r'^Makefile$',
        r'(^|/)conftest\.py$',
        r'(^|/)(pytest\.ini|setup\.cfg|tox\.ini|\.coveragerc|\.?ruff\.toml)$',
        r'^apps/(web|desktop)/biome\.jsonc?$',
        r'^apps/(web|desktop)/(vitest|playwright)\.(config|setup)\.\w+$',
        r'^apps/(web|desktop)/tsconfig[\w.-]*\.json$',
    )
]

# Files whose lint and test settings are compared as data, so a dependency
# bump in the same file is not a gate change.
PYPROJECT = 'apps/server/pyproject.toml'
PACKAGE_JSONS = ('apps/web/package.json', 'apps/desktop/package.json')

TEST_FILES = [
    re.compile(p)
    for p in (
        r'^apps/server/tests/.*\.py$',
        r'^apps/(web|desktop)/.*\.(test|spec)\.(ts|tsx|js|mjs)$',
        r'^apps/web/e2e/',
        r'^apps/desktop/test/',
    )
]
TEST_DEFINITION = {
    'python': re.compile(r'^\s*(async\s+)?def\s+test_\w*\s*\('),
    'js': re.compile(r'^\s*(it|test)(\.each\(.*?\))?\s*\(\s*[\'"`]'),
}

# Golden files and recorded fixtures: tests compare against them, so
# rewriting one can make a failing test pass.
GOLDEN_FILES = [
    re.compile(p)
    for p in (r'^apps/server/tests/fixtures/', r'^apps/desktop/test/fixtures/', r'^docs/serving-baseline/')
]

# AGENTS.md: applied migrations are never edited, prompt files are
# identified by their exact bytes, decisions.md entries are history.
IMMUTABLE = [
    (re.compile(r'^apps/server/local_llm/migrations/versions/'), 'an applied migration (the schema is append-only)'),
    (re.compile(r'^apps/server/local_llm/benchmarks/data/prompts/'), 'a benchmark prompt (identified by its bytes)'),
]
DECISIONS = 'docs/decisions.md'

SUPPRESSIONS = {
    'python': [
        (re.compile(r'pytest\.mark\.(skip|skipif|xfail)\b'), 'pytest skip/xfail markers'),
        (re.compile(r'\bpytest\.(skip|xfail|importorskip)\('), 'pytest.skip/xfail calls'),
        (re.compile(r'#\s*noqa\b', re.IGNORECASE), '`# noqa` comments'),
        (re.compile(r'#\s*ruff\s*:\s*noqa', re.IGNORECASE), '`# ruff: noqa` comments'),
        (re.compile(r'#\s*type\s*:\s*ignore'), '`# type: ignore` comments'),
        (re.compile(r'#\s*pyright\s*:\s*ignore'), '`# pyright: ignore` comments'),
        (re.compile(r'#\s*pragma\s*:\s*no\s*(cover|branch)'), '`# pragma: no cover/branch` comments'),
    ],
    'js': [
        (
            re.compile(r'\b(describe|it|test)\.(skip|skipIf|runIf|only|fixme|todo|fails|failing|fail)\b'),
            'skipped, focused or expected-to-fail tests',
        ),
        (re.compile(r'\b(xit|xdescribe|xtest|fit|fdescribe)\('), 'x-/f-prefixed (skipped or focused) tests'),
        (re.compile(r'biome-ignore'), '`biome-ignore` comments'),
        (re.compile(r'@ts-(ignore|expect-error|nocheck)'), 'TypeScript suppressions'),
        (re.compile(r'eslint-disable'), '`eslint-disable` comments'),
        (re.compile(r'\b(v8|c8|istanbul)\s+ignore\b'), 'coverage-ignore comments'),
    ],
}
LANGUAGE_BY_SUFFIX = {
    '.py': 'python',
    '.ts': 'js',
    '.tsx': 'js',
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.jsx': 'js',
    '.astro': 'js',
}

# `uses: owner/repo[/path]@<40-hex sha> # vX.Y.Z`, the only workflow line
# Dependabot's github-actions updates change.
ACTION_PIN = re.compile(r'^\s*(-\s*)?uses:\s*([\w.-]+/[\w./-]+)@([0-9a-f]{40})\s*(#\s*\S+)?\s*$')


@dataclass
class FileChange:
    filename: str
    status: str  # added, removed, modified, renamed, copied, changed, unchanged
    patch: str | None = None  # None when GitHub omits it (binary or too large)
    previous_filename: str | None = None


@dataclass
class PullRequest:
    number: int
    title: str
    body: str
    author: str
    labels: list[str]
    files: list[FileChange]
    commit_messages: list[str] = field(default_factory=list)
    commit_authors: list[str] = field(default_factory=list)
    truncated_files: bool = False  # GitHub lists at most 3000 files


ReadFile = Callable[[str, str], 'str | None']  # (path, 'base' | 'head') -> text, None if absent


def language(path: str) -> str | None:
    return LANGUAGE_BY_SUFFIX.get(os.path.splitext(path)[1])


def matches(patterns: Iterable[re.Pattern[str]], path: str) -> bool:
    return any(p.search(path) for p in patterns)


def patch_lines(patch: str | None) -> tuple[list[str], list[str]]:
    """Added and removed lines of a REST API patch (hunks only, no file headers)."""
    added: list[str] = []
    removed: list[str] = []
    for line in (patch or '').splitlines():
        if line.startswith('@@') or line.startswith('\\'):
            continue
        if line.startswith('+'):
            added.append(line[1:])
        elif line.startswith('-'):
            removed.append(line[1:])
    return added, removed


# --- Checks that never need approval: they are fixed by editing the PR. ---


def check_title(title: str) -> list[str]:
    if CONVENTIONAL_TITLE.match(title):
        return []
    return [
        f'The title {title!r} is not a conventional commit (`type(scope): summary`, '
        'type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert). '
        'The squash merge uses it as the commit subject.'
    ]


def check_attribution(pr: PullRequest) -> list[str]:
    problems = []
    for where, text in [('the title', pr.title), ('the PR body', pr.body)] + [
        (f'commit message {i + 1}', m) for i, m in enumerate(pr.commit_messages)
    ]:
        for pattern in ATTRIBUTION:
            found = pattern.search(text or '')
            if found:
                problems.append(
                    f'{where} carries an attribution line ({found.group(0).strip()!r}); AGENTS.md forbids it.'
                )
                break
    return problems


# --- The tripwire. ---


def _is_action_pin_bump(patch: str | None) -> bool:
    """True when a patch only moves `uses:` pins of the same actions to new SHAs."""
    added, removed = patch_lines(patch)
    if not added or len(added) != len(removed):
        return False
    old = [m.group(2) for line in removed if (m := ACTION_PIN.match(line))]
    new = [m.group(2) for line in added if (m := ACTION_PIN.match(line))]
    return len(old) == len(removed) and len(new) == len(added) and sorted(old) == sorted(new)


def _toml(text: str | None) -> dict:
    return tomllib.loads(text) if text else {}


def _json(text: str | None) -> dict:
    return json.loads(text) if text else {}


def _structured_findings(change: FileChange, read_file: ReadFile) -> list[str]:
    path = change.filename
    findings = []
    try:
        if path == PYPROJECT:
            base, head = _toml(read_file(path, 'base')), _toml(read_file(path, 'head'))
            if base.get('tool') != head.get('tool'):
                findings.append(f'`{path}`: the `[tool.*]` settings (ruff, pytest, uv) changed.')

            def dev_names(doc: dict) -> set[str]:
                return {
                    re.split(r'[\s<>=!~;\[]', spec, maxsplit=1)[0].lower()
                    for spec in doc.get('dependency-groups', {}).get('dev', [])
                    if isinstance(spec, str)
                }

            dropped = dev_names(base) - dev_names(head)
            if dropped:
                findings.append(f'`{path}`: removed from the dev group: {", ".join(sorted(dropped))}.')
        elif path in PACKAGE_JSONS:
            base, head = _json(read_file(path, 'base')), _json(read_file(path, 'head'))
            if base.get('scripts') != head.get('scripts'):
                findings.append(f'`{path}`: `scripts` changed (CI runs them).')
            dropped = set(base.get('devDependencies', {})) - set(head.get('devDependencies', {}))
            if dropped:
                findings.append(f'`{path}`: removed devDependencies: {", ".join(sorted(dropped))}.')
    except (ValueError, tomllib.TOMLDecodeError) as exc:
        findings.append(f'`{path}`: could not be parsed to compare its settings ({exc}).')
    return findings


def tripwire(pr: PullRequest, read_file: ReadFile) -> list[str]:
    findings: list[str] = []
    dependabot_only = pr.author == DEPENDABOT and all(a == DEPENDABOT for a in pr.commit_authors)
    if pr.truncated_files:
        findings.append('The PR changes more files than the API lists (3000), so it could not be checked in full.')

    net_suppressions: dict[str, int] = {}
    suppression_examples: dict[str, list[str]] = {}
    tests_added = tests_removed = 0

    for change in pr.files:
        path, status = change.filename, change.status
        paths = [path] + ([change.previous_filename] if change.previous_filename else [])

        # Gate files.
        for p in paths:
            if matches(PROTECTED_PATHS, p):
                if dependabot_only and status == 'modified' and _is_action_pin_bump(change.patch):
                    continue
                findings.append(f'`{p}` is a CI gate file ({status}).')
                break
        if path == PYPROJECT or path in PACKAGE_JSONS:
            findings.extend(_structured_findings(change, read_file))

        # Append-only and golden files.
        for pattern, what in IMMUTABLE:
            if status != 'added' and any(pattern.search(p) for p in paths):
                findings.append(f'`{path}` is {what} and was {status}.')
        if status != 'added' and any(matches(GOLDEN_FILES, p) for p in paths):
            findings.append(f'`{path}` is a golden file or recorded fixture and was {status}.')
        if path == DECISIONS:
            _, removed = patch_lines(change.patch)
            if change.patch is None or removed or status != 'modified':
                findings.append(f'`{DECISIONS}`: existing entries were changed or removed; add a new entry instead.')

        # Deleted tests.
        if status == 'removed' and matches(TEST_FILES, path):
            findings.append(f'The test file `{path}` was deleted.')
        if status == 'renamed' and change.previous_filename and matches(TEST_FILES, change.previous_filename):
            if not matches(TEST_FILES, path):
                findings.append(f'The test file `{change.previous_filename}` was moved out of the test suites.')

        lang = language(path)
        # .github/ already trips as a whole, and this script's own patterns
        # and fixtures would read as suppressions.
        if lang is None or path.startswith('.github/'):
            continue
        if change.patch is None and status not in ('removed', 'renamed'):
            findings.append(f'`{path}`: GitHub did not return its diff (too large), so it could not be inspected.')
            continue
        added, removed = patch_lines(change.patch)

        if matches(TEST_FILES, path):
            definition = TEST_DEFINITION[lang]
            tests_added += sum(1 for line in added if definition.search(line))
            tests_removed += sum(1 for line in removed if definition.search(line))

        for pattern, what in SUPPRESSIONS[lang]:
            plus = [line for line in added if pattern.search(line)]
            minus = sum(1 for line in removed if pattern.search(line))
            net_suppressions[what] = net_suppressions.get(what, 0) + len(plus) - minus
            suppression_examples.setdefault(what, []).extend(f'`{path}`: `{line.strip()[:120]}`' for line in plus)

    for what, net in net_suppressions.items():
        if net > 0:
            examples = '; '.join(suppression_examples[what][:5])
            findings.append(f'{net} new {what}, net of any removed (added: {examples}).')
    if tests_removed > tests_added:
        findings.append(
            f'{tests_removed - tests_added} fewer test definitions than before '
            f'({tests_removed} removed, {tests_added} added).'
        )
    return findings


def justification(body: str) -> str:
    match = JUSTIFICATION_HEADING.search(body or '')
    if not match:
        return ''
    rest = body[match.end() :]
    following = re.search(r'^#{1,2}\s', rest, re.MULTILINE)
    return (rest[: following.start()] if following else rest).strip()


def approval_problems(pr: PullRequest) -> list[str]:
    problems = []
    if APPROVAL_LABEL not in pr.labels:
        problems.append(f'The `{APPROVAL_LABEL}` label is not on the PR (a push removes it).')
    if len(re.sub(r'\s', '', justification(pr.body))) < MIN_JUSTIFICATION_CHARS:
        problems.append('The PR body has no `## Gate changes` section saying why each finding is needed.')
    return problems


BYPASS_RULE = """\
!!! NO AGENT MAY EVER BYPASS THIS TRIPWIRE WITHOUT FIRST ASKING THE OWNER FOR
!!! EXPLICIT PERMISSION AND GIVING EXPLICIT REASONING FOR THE BYPASS.

Agents: stop here and ask the repository owner. List every finding above and
explain, for each one, why the change is needed and why it does not weaken
what CI catches. Do not apply the label, merge around this check, or edit,
disable or weaken the tripwire yourself, unless the owner has explicitly
said yes to that specific bypass in reply to that reasoning.

The owner approves by adding the `gate-change-approved` label once the PR
body's `## Gate changes` section records the reasoning. See AGENTS.md,
"The CI tripwire"."""


def evaluate(pr: PullRequest, read_file: ReadFile) -> tuple[bool, str]:
    """Run every check; return (passed, a Markdown report)."""
    lines = [f'# PR gate for #{pr.number}', '']
    ok = True

    title = check_title(pr.title)
    attribution = check_attribution(pr)
    for heading, problems in (('Title', title), ('Attribution', attribution)):
        lines.append(f'## {heading}: {"fail" if problems else "pass"}')
        lines.extend(f'- {p}' for p in problems)
        lines.append('')
        ok = ok and not problems

    findings = tripwire(pr, read_file)
    if not findings:
        lines += ['## Tripwire: pass', '', 'Nothing in this PR changes a CI gate or weakens a test.']
        return ok, '\n'.join(lines)

    lines += ['## Tripwire: findings', '']
    lines.extend(f'- {f}' for f in findings)
    lines.append('')
    problems = approval_problems(pr)
    if problems:
        ok = False
        lines += ['### Not approved', '']
        lines.extend(f'- {p}' for p in problems)
        lines += ['', '```', BYPASS_RULE, '```']
    else:
        lines += [
            '### Approved by the owner',
            '',
            f'The `{APPROVAL_LABEL}` label is on this commit and the PR body explains:',
            '',
            *[f'> {line}' for line in justification(pr.body).splitlines()],
        ]
    return ok, '\n'.join(lines)


# --- GitHub REST API. ---


class GitHub:
    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.token = token

    def request(self, method: str, path: str) -> object:
        url = path if path.startswith('https://') else f'https://api.github.com/repos/{self.repo}/{path}'
        req = urllib.request.Request(url, method=method)
        req.add_header('Authorization', f'Bearer {self.token}')
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('X-GitHub-Api-Version', '2022-11-28')
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        return json.loads(data) if data else None

    def paginate(self, path: str, limit: int) -> tuple[list, bool]:
        items: list = []
        page = 1
        while len(items) < limit:
            batch = self.request('GET', f'{path}?per_page=100&page={page}')
            assert isinstance(batch, list)
            items.extend(batch)
            if len(batch) < 100:
                return items, False
            page += 1
        return items, True

    def file_text(self, path: str, ref: str) -> str | None:
        quoted = urllib.parse.quote(path)
        try:
            data = self.request('GET', f'contents/{quoted}?ref={ref}')
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise
        assert isinstance(data, dict)
        return base64.b64decode(data['content']).decode()

    def load(self, number: int) -> tuple[PullRequest, str, str]:
        raw = self.request('GET', f'pulls/{number}')
        assert isinstance(raw, dict)
        files, truncated = self.paginate(f'pulls/{number}/files', 3000)
        commits, _ = self.paginate(f'pulls/{number}/commits', 250)
        pr = PullRequest(
            number=number,
            title=raw['title'],
            body=raw.get('body') or '',
            author=raw['user']['login'],
            labels=[label['name'] for label in raw['labels']],
            files=[FileChange(f['filename'], f['status'], f.get('patch'), f.get('previous_filename')) for f in files],
            commit_messages=[c['commit']['message'] for c in commits],
            commit_authors=[(c.get('author') or {}).get('login', '') for c in commits],
            truncated_files=truncated,
        )
        return pr, raw['base']['sha'], raw['head']['sha']


def run(gh: GitHub, number: int, *, action: str | None, write: bool) -> int:
    pr, base_sha, head_sha = gh.load(number)
    if action == 'synchronize' and APPROVAL_LABEL in pr.labels:
        # An approval covers the commits it was given for, not later ones.
        if write:
            gh.request('DELETE', f'issues/{number}/labels/{APPROVAL_LABEL}')
        pr.labels.remove(APPROVAL_LABEL)

    def read_file(path: str, side: str) -> str | None:
        return gh.file_text(path, base_sha if side == 'base' else head_sha)

    ok, report = evaluate(pr, read_file)
    if os.environ.get('GITHUB_ACTIONS'):
        # The report quotes the PR's diff; stop GitHub from reading any of it
        # as a workflow command.
        stop = secrets.token_hex(16)
        print(f'::stop-commands::{stop}')
        print(report)
        print(f'::{stop}::')
    else:
        print(report)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as fh:
            fh.write(report + '\n')
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--github', action='store_true', help='run from the pr-gate workflow')
    mode.add_argument('--pr', type=int, help='check this PR read-only, with `gh auth token`')
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', 'epittman23/local-llm'))
    args = parser.parse_args(argv)

    if args.github:
        with open(os.environ['GITHUB_EVENT_PATH']) as fh:
            event = json.load(fh)
        gh = GitHub(args.repo, os.environ['GITHUB_TOKEN'])
        return run(gh, event['pull_request']['number'], action=event.get('action'), write=True)

    token = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, check=True).stdout.strip()
    return run(GitHub(args.repo, token), args.pr, action=None, write=False)


if __name__ == '__main__':
    sys.exit(main())
