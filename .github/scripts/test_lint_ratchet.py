"""Tests for lint_ratchet.py. Run with `python3 -m unittest discover -s .github/scripts`."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import lint_ratchet as r

PYRIGHT = {
    'generalDiagnostics': [
        {'file': str(r.REPO / 'apps/server/local_llm/a.py'), 'severity': 'error', 'rule': 'reportX', 'message': 'm1'},
        {'file': str(r.REPO / 'apps/server/local_llm/a.py'), 'severity': 'error', 'rule': 'reportX', 'message': 'm2'},
        {'file': str(r.REPO / 'apps/server/local_llm/b.py'), 'severity': 'warning', 'rule': 'reportY', 'message': 'm'},
        {'file': str(r.REPO / 'apps/server/local_llm/b.py'), 'severity': 'information', 'rule': 'reportZ'},
    ]
}
BIOME = {
    'diagnostics': [
        {'severity': 'error', 'category': 'lint/suspicious/noArrayIndexKey', 'location': {'path': 'src/a.tsx'}},
        {'severity': 'warning', 'category': 'lint/suspicious/noExplicitAny', 'location': {'path': 'src/a.tsx'}},
        {'severity': 'info', 'category': 'lint/style/useTemplate', 'location': {'path': 'src/a.tsx'}},
        {'severity': 'info', 'category': 'deserialize', 'location': {'path': 'biome.jsonc'}},
    ]
}


class ParseTests(unittest.TestCase):
    def test_basedpyright_counts_errors_and_warnings_by_file_and_rule(self):
        counts = r.count(r.findings('basedpyright', PYRIGHT))
        self.assertEqual(
            counts, {'apps/server/local_llm/a.py': {'reportX': 2}, 'apps/server/local_llm/b.py': {'reportY': 1}}
        )

    def test_biome_counts_lint_errors_and_warnings_repo_relative(self):
        counts = r.count(r.findings('biome', BIOME, prefix='apps/web'))
        self.assertEqual(
            counts,
            {'apps/web/src/a.tsx': {'lint/suspicious/noArrayIndexKey': 1, 'lint/suspicious/noExplicitAny': 1}},
        )


class RatchetTests(unittest.TestCase):
    def run_main(self, mode, report, baseline_counts):
        with tempfile.TemporaryDirectory() as tmp:
            report_path, baseline_path = Path(tmp, 'report.json'), Path(tmp, 'baseline.json')
            report_path.write_text(json.dumps(report))
            if baseline_counts is not None:
                r.write_baseline(baseline_path, 'basedpyright', baseline_counts)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                code = r.main([mode, 'basedpyright', str(report_path), str(baseline_path)])
            written = json.loads(baseline_path.read_text())['counts'] if baseline_path.exists() else None
            return code, out.getvalue(), written

    def test_at_the_baseline_passes(self):
        code, _, _ = self.run_main('check', PYRIGHT, r.count(r.findings('basedpyright', PYRIGHT)))
        self.assertEqual(code, 0)

    def test_a_new_finding_fails_and_is_listed(self):
        baseline = {'apps/server/local_llm/a.py': {'reportX': 1}, 'apps/server/local_llm/b.py': {'reportY': 1}}
        code, out, _ = self.run_main('check', PYRIGHT, baseline)
        self.assertEqual(code, 1)
        self.assertIn('apps/server/local_llm/a.py: reportX: 2 (baseline 1)', out)
        self.assertIn('m2', out)

    def test_fewer_findings_pass_with_a_notice(self):
        baseline = {'apps/server/local_llm/a.py': {'reportX': 5}, 'apps/server/local_llm/b.py': {'reportY': 1}}
        code, out, _ = self.run_main('check', PYRIGHT, baseline)
        self.assertEqual(code, 0)
        self.assertIn('make baselines', out)

    def test_update_shrinks_but_never_grows(self):
        bigger = {'apps/server/local_llm/a.py': {'reportX': 5}, 'apps/server/local_llm/b.py': {'reportY': 1}}
        code, _, written = self.run_main('update', PYRIGHT, bigger)
        self.assertEqual((code, written['apps/server/local_llm/a.py']['reportX']), (0, 2))
        smaller = {'apps/server/local_llm/a.py': {'reportX': 1}}
        code, _, written = self.run_main('update', PYRIGHT, smaller)
        self.assertEqual((code, written), (1, smaller))

    def test_update_creates_a_missing_baseline(self):
        code, _, written = self.run_main('update', PYRIGHT, None)
        self.assertEqual((code, written['apps/server/local_llm/a.py']['reportX']), (0, 2))


if __name__ == '__main__':
    unittest.main()
