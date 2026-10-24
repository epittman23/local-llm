"""Tests for pr_gate.py. Run with `python3 -m unittest discover -s .github/scripts`.

The workflow runs pr_gate.py from main under pull_request_target, so a PR
that changes it never runs its own version: these tests are what checks a
change to it before it merges.
"""

import contextlib
import io
import json
import unittest

import pr_gate as g

SHA_A = 'a' * 40
SHA_B = 'b' * 40


def pr(files=(), *, title='fix(web): a thing', body='', author='epittman23', labels=(), commits=None, authors=None):
    commits = ['fix(web): a thing'] if commits is None else commits
    return g.PullRequest(
        number=1,
        title=title,
        body=body,
        author=author,
        labels=list(labels),
        files=list(files),
        commit_messages=commits,
        commit_authors=authors if authors is not None else [author] * len(commits),
    )


def change(filename, status='modified', patch='', previous=None):
    return g.FileChange(filename, status, patch, previous)


def no_files(path, side):
    return None


def files_from(base: dict, head: dict):
    return lambda path, side: (base if side == 'base' else head).get(path)


APPROVAL_BODY = 'Summary.\n\n## Gate changes\n\nThe new job only adds a check; nothing is removed or loosened.\n'


class TitleTests(unittest.TestCase):
    def test_conventional_titles_pass(self):
        for title in (
            'fix(web): make UUIDs without crypto.randomUUID',
            'build(deps): bump the web-minor-patch group in /apps/web with 19 updates',
            'docs(llama-cpp): record the build',
            'feat!: drop a thing',
            'ci: scan commits for secrets',
        ):
            self.assertEqual(g.check_title(title), [], title)

    def test_other_titles_fail(self):
        for title in ('Feat/open web UI fork', 'fix: ', 'update stuff', 'Fix(web): capitalised type', 'wip(web): x'):
            self.assertTrue(g.check_title(title), title)


class AttributionTests(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(g.check_attribution(pr(body='Just a body.')), [])

    def test_body_and_commits_are_checked(self):
        for case in (
            pr(body='Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
            pr(commits=['fix: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']),
            pr(commits=['fix: x\n\nClaude-Session: https://claude.ai/code/session_1']),
        ):
            self.assertTrue(g.check_attribution(case))

    def test_a_human_co_author_is_fine(self):
        self.assertEqual(g.check_attribution(pr(commits=['fix: x\n\nCo-authored-by: Someone <s@example.com>'])), [])


class ProtectedPathTests(unittest.TestCase):
    def test_gate_files_trip(self):
        for path in (
            '.github/workflows/ci.yml',
            '.github/scripts/pr_gate.py',
            '.github/dependabot.yml',
            '.pre-commit-config.yaml',
            '.gitleaksignore',
            'Makefile',
            'apps/web/.gitignore',
            'apps/server/tests/conftest.py',
            'apps/web/biome.jsonc',
            'apps/web/vitest.config.ts',
            'apps/web/vitest.setup.ts',
            'apps/web/playwright.config.ts',
            'apps/desktop/tsconfig.build.json',
        ):
            self.assertTrue(g.tripwire(pr([change(path)]), no_files), path)

    def test_ordinary_files_pass(self):
        for path in ('apps/web/src/lib/x.ts', 'apps/server/local_llm/main.py', 'docs/guides/testing.md', 'README.md'):
            self.assertEqual(g.tripwire(pr([change(path)]), no_files), [], path)

    def test_a_rename_out_of_a_gate_path_trips(self):
        self.assertTrue(
            g.tripwire(pr([change('docs/old-ci.yml', 'renamed', previous='.github/workflows/ci.yml')]), no_files)
        )


class DependabotTests(unittest.TestCase):
    PIN_BUMP = (
        '@@ -1,3 +1,3 @@\n'
        f'-      - uses: actions/checkout@{SHA_A} # v7.0.1\n'
        f'+      - uses: actions/checkout@{SHA_B} # v7.0.2\n'
    )

    def bot(self, patch):
        return pr([change('.github/workflows/ci.yml', patch=patch)], author=g.DEPENDABOT)

    def test_a_pin_bump_passes(self):
        self.assertEqual(g.tripwire(self.bot(self.PIN_BUMP), no_files), [])

    def test_swapping_the_action_trips(self):
        patch = f'-      - uses: actions/checkout@{SHA_A} # v7\n+      - uses: evil/checkout@{SHA_B} # v7\n'
        self.assertTrue(g.tripwire(self.bot(patch), no_files))

    def test_an_extra_line_trips(self):
        self.assertTrue(g.tripwire(self.bot(self.PIN_BUMP + '+        continue-on-error: true\n'), no_files))

    def test_an_unpinned_ref_trips(self):
        patch = f'-      - uses: actions/checkout@{SHA_A} # v7\n+      - uses: actions/checkout@main\n'
        self.assertTrue(g.tripwire(self.bot(patch), no_files))

    def test_only_for_dependabot(self):
        self.assertTrue(g.tripwire(pr([change('.github/workflows/ci.yml', patch=self.PIN_BUMP)]), no_files))

    def test_not_when_someone_else_pushed_to_its_branch(self):
        bumped = pr(
            [change('.github/workflows/ci.yml', patch=self.PIN_BUMP)],
            author=g.DEPENDABOT,
            commits=['a', 'b'],
            authors=[g.DEPENDABOT, 'someone'],
        )
        self.assertTrue(g.tripwire(bumped, no_files))


class StructuredFileTests(unittest.TestCase):
    PYPROJECT = (
        '[project]\ndependencies = ["fastapi==1.0"]\n'
        '[dependency-groups]\ndev = ["pytest", "ruff>=0.17.0"]\n'
        '[tool.ruff.lint]\nselect = ["E", "F"]\n'
    )

    def check(self, path, base, head):
        return g.tripwire(pr([change(path)]), files_from({path: base}, {path: head}))

    def test_a_dependency_bump_passes(self):
        head = self.PYPROJECT.replace('fastapi==1.0', 'fastapi==1.1').replace('ruff>=0.17.0', 'ruff>=0.17.2')
        self.assertEqual(self.check(g.PYPROJECT, self.PYPROJECT, head), [])

    def test_a_ruff_setting_trips(self):
        self.assertTrue(self.check(g.PYPROJECT, self.PYPROJECT, self.PYPROJECT.replace('"E", "F"', '"F"')))

    def test_dropping_a_dev_tool_trips(self):
        self.assertTrue(self.check(g.PYPROJECT, self.PYPROJECT, self.PYPROJECT.replace('"pytest", ', '')))

    def test_package_json(self):
        base = {
            'scripts': {'test:unit': 'vitest run'},
            'dependencies': {'react': '19.0.0'},
            'devDependencies': {'vitest': '4'},
        }
        bumped = {**base, 'dependencies': {'react': '19.1.0'}}
        weakened = {**base, 'scripts': {'test:unit': 'true'}}
        dropped = {**base, 'devDependencies': {}}
        path = 'apps/web/package.json'
        self.assertEqual(self.check(path, json.dumps(base), json.dumps(bumped)), [])
        self.assertTrue(self.check(path, json.dumps(base), json.dumps(weakened)))
        self.assertTrue(self.check(path, json.dumps(base), json.dumps(dropped)))


class SuppressionTests(unittest.TestCase):
    def test_new_suppressions_trip(self):
        for path, line in (
            ('apps/server/local_llm/x.py', 'x = 1  # noqa: E501'),
            ('apps/server/local_llm/x.py', 'y = f()  # type: ignore[attr-defined]'),
            ('apps/server/tests/test_x.py', '@pytest.mark.skip(reason="flaky")'),
            ('apps/server/tests/test_x.py', "    pytest.skip('later')"),
            ('apps/web/src/a.test.tsx', "it.skip('renders', () => {"),
            ('apps/web/e2e/chat.spec.ts', "test.only('sends', async () => {"),
            ('apps/web/src/a.test.ts', "it.skipIf(ci)('renders', () => {"),
            ('apps/web/src/a.tsx', '// biome-ignore lint/a11y/useKeyWithClickEvents: x'),
            ('apps/web/src/a.ts', '// @ts-expect-error'),
            ('apps/web/src/a.ts', '/* v8 ignore next */'),
            ('apps/web/src/a.ts', '/* istanbul ignore else */'),
            ('apps/server/local_llm/x.py', 'if x:  # pragma: no branch'),
        ):
            self.assertTrue(g.tripwire(pr([change(path, patch=f'@@ -1 +1 @@\n+{line}\n')]), no_files), line)

    def test_moving_a_suppression_nets_out(self):
        moved = [
            change('apps/server/local_llm/a.py', patch='-x = 1  # noqa: E501\n'),
            change('apps/server/local_llm/b.py', patch='+x = 1  # noqa: E501\n'),
        ]
        self.assertEqual(g.tripwire(pr(moved), no_files), [])

    def test_ordinary_code_passes(self):
        patch = '+def skip_header(rows):\n+    return rows[1:]\n+const only = items.filter(Boolean);\n'
        self.assertEqual(g.tripwire(pr([change('apps/server/local_llm/a.py', patch=patch)]), no_files), [])

    def test_the_gate_scripts_report_once_as_gate_files(self):
        patch = "+    (re.compile(r'#\\s*noqa'), 'noqa comments'),\n"
        findings = g.tripwire(pr([change('.github/scripts/pr_gate.py', patch=patch)]), no_files)
        self.assertEqual(findings, ['`.github/scripts/pr_gate.py` is a CI gate file (modified).'])

    def test_a_missing_diff_trips(self):
        self.assertTrue(g.tripwire(pr([change('apps/server/local_llm/huge.py', patch=None)]), no_files))


class TestRemovalTests(unittest.TestCase):
    def test_deleting_a_test_file_trips(self):
        self.assertTrue(g.tripwire(pr([change('apps/server/tests/test_x.py', 'removed', patch=None)]), no_files))
        self.assertTrue(g.tripwire(pr([change('apps/web/src/lib/a.test.ts', 'removed', patch=None)]), no_files))

    def test_renaming_within_the_suites_passes(self):
        renamed = change('apps/server/tests/test_new.py', 'renamed', previous='apps/server/tests/test_old.py')
        self.assertEqual(g.tripwire(pr([renamed]), no_files), [])

    def test_net_fewer_test_definitions_trips(self):
        patch = '-def test_one():\n-    assert f()\n-async def test_two():\n+def test_both():\n'
        self.assertTrue(g.tripwire(pr([change('apps/server/tests/test_x.py', patch=patch)]), no_files))
        js = "-  it('a', () => {});\n-  test('b', async () => {});\n"
        self.assertTrue(g.tripwire(pr([change('apps/web/src/a.test.tsx', patch=js)]), no_files))

    def test_adding_tests_passes(self):
        patch = '+def test_three():\n+    assert g()\n'
        self.assertEqual(g.tripwire(pr([change('apps/server/tests/test_x.py', patch=patch)]), no_files), [])


class AppendOnlyTests(unittest.TestCase):
    def test_editing_an_applied_migration_trips(self):
        path = 'apps/server/local_llm/migrations/versions/7e5b5dc7342b_init.py'
        self.assertTrue(g.tripwire(pr([change(path, patch='-a\n+b\n')]), no_files))

    def test_adding_a_migration_passes(self):
        path = 'apps/server/local_llm/migrations/versions/abc_new.py'
        self.assertEqual(g.tripwire(pr([change(path, 'added', patch='+x = 1\n')]), no_files), [])

    def test_a_prompt_file_or_golden_file_edit_trips(self):
        for path in (
            'apps/server/local_llm/benchmarks/data/prompts/assistant.txt',
            'apps/server/tests/fixtures/chat_payload_golden.json',
            'docs/serving-baseline/fingerprints.json',
        ):
            self.assertTrue(g.tripwire(pr([change(path, patch='-a\n+b\n')]), no_files), path)

    def test_decisions_log_is_append_only(self):
        added = change(g.DECISIONS, patch='@@ -9,0 +10,2 @@\n+- **2026-10-24**: new\n+  entry\n')
        edited = change(g.DECISIONS, patch='@@ -10 +10 @@\n-- **2026-10-23**: old\n+- **2026-10-23**: changed\n')
        self.assertEqual(g.tripwire(pr([added]), no_files), [])
        self.assertTrue(g.tripwire(pr([edited]), no_files))


class ShrinkOnlyTests(unittest.TestCase):
    def counts(self, **files):
        return json.dumps({'counts': files})

    def check(self, path, base, head, status='modified'):
        return g.tripwire(pr([change(path, status)]), files_from({path: base}, {path: head}))

    def test_shrinking_a_counts_baseline_passes(self):
        base = self.counts(**{'a.py': {'reportX': 3}, 'b.py': {'reportY': 1}})
        head = self.counts(**{'a.py': {'reportX': 2}})
        self.assertEqual(self.check('apps/server/basedpyright-baseline.json', base, head), [])

    def test_growing_a_counts_baseline_trips(self):
        base = self.counts(**{'a.py': {'reportX': 3}})
        for head in (self.counts(**{'a.py': {'reportX': 4}}), self.counts(**{'a.py': {'reportX': 3, 'reportZ': 1}})):
            self.assertTrue(self.check('apps/web/biome-baseline.json', base, head))

    def test_the_schema_drift_list_may_only_shrink(self):
        path = 'apps/server/tests/fixtures/schema_drift.json'
        self.assertEqual(self.check(path, '["a", "b"]', '["a"]'), [])
        self.assertTrue(self.check(path, '["a"]', '["a", "c"]'))

    def test_adding_or_removing_a_baseline_trips(self):
        path = 'apps/web/biome-baseline.json'
        self.assertTrue(self.check(path, None, self.counts(), status='added'))
        self.assertTrue(g.tripwire(pr([change(path, 'removed')]), no_files))


class ApprovalTests(unittest.TestCase):
    GATE = [change('.github/workflows/ci.yml')]

    def test_unapproved_findings_fail_and_state_the_rule(self):
        ok, report = g.evaluate(pr(self.GATE), no_files)
        self.assertFalse(ok)
        self.assertIn('NO AGENT MAY EVER BYPASS THIS TRIPWIRE', report)

    def test_a_label_alone_is_not_enough(self):
        ok, _ = g.evaluate(pr(self.GATE, labels=[g.APPROVAL_LABEL]), no_files)
        self.assertFalse(ok)

    def test_a_justification_alone_is_not_enough(self):
        ok, _ = g.evaluate(pr(self.GATE, body=APPROVAL_BODY), no_files)
        self.assertFalse(ok)

    def test_an_empty_section_is_not_a_justification(self):
        body = 'x\n\n## Gate changes\n\nok\n\n## Testing\n\nLots and lots of words about testing go here.\n'
        ok, _ = g.evaluate(pr(self.GATE, body=body, labels=[g.APPROVAL_LABEL]), no_files)
        self.assertFalse(ok)

    def test_label_and_justification_pass_and_quote_it(self):
        ok, report = g.evaluate(pr(self.GATE, body=APPROVAL_BODY, labels=[g.APPROVAL_LABEL]), no_files)
        self.assertTrue(ok)
        self.assertIn('> The new job only adds a check', report)

    def test_the_label_does_not_excuse_a_bad_title(self):
        approved = pr(self.GATE, title='Update CI', body=APPROVAL_BODY, labels=[g.APPROVAL_LABEL])
        self.assertFalse(g.evaluate(approved, no_files)[0])

    def test_a_clean_pr_passes_without_approval(self):
        self.assertTrue(g.evaluate(pr([change('apps/web/src/a.ts', patch='+const a = 1;\n')]), no_files)[0])


class PushRemovesApprovalTests(unittest.TestCase):
    class FakeGitHub:
        def __init__(self, labels):
            self.labels = labels
            self.deleted = []

        def load(self, number):
            return (
                pr([change('Makefile')], body=APPROVAL_BODY, labels=list(self.labels)),
                SHA_A,
                SHA_B,
            )

        def request(self, method, path):
            self.deleted.append((method, path))

        def file_text(self, path, ref):
            return None

    def test_a_push_removes_the_label_and_fails(self):
        fake = self.FakeGitHub([g.APPROVAL_LABEL])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(g.run(fake, 1, action='synchronize', write=True), 1)
        self.assertEqual(fake.deleted, [('DELETE', f'issues/1/labels/{g.APPROVAL_LABEL}')])

    def test_labelling_after_the_push_passes(self):
        fake = self.FakeGitHub([g.APPROVAL_LABEL])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(g.run(fake, 1, action='labeled', write=True), 0)
        self.assertEqual(fake.deleted, [])


if __name__ == '__main__':
    unittest.main()
