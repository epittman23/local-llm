"""Tests for astro_check.py. Run with `python3 -m unittest discover -s .github/scripts`."""

import contextlib
import io
import sys
import unittest

import astro_check as a

# What CI's step printed from #768 on, exit status 0 (ANSI codes as sent).
MISSING_CHECKER = (
    'To continue, Astro requires the following dependency to be installed: \x1b[1m@astrojs/check\x1b[22m. '
    'Packages cannot be installed automatically in CI environments.\n'
    '\x1b[31m\x1b[1m20:31:47\x1b[22m [ERROR] [check]\x1b[39m The `@astrojs/check` and `typescript` packages '
    'are required for this command to work. Please manually install them into your project and try again.\n'
)
CHECKED = '\x1b[1mResult (580 files): \x1b[22m\n- \x1b[1m0 errors\x1b[22m\n- 0 warnings\n- 20 hints\n'


class ProblemTests(unittest.TestCase):
    def test_a_run_with_its_summary_passes(self):
        self.assertIsNone(a.problem(0, CHECKED))

    def test_exit_zero_without_a_summary_fails(self):
        self.assertIn('checked nothing', a.problem(0, MISSING_CHECKER))

    def test_a_nonzero_exit_fails_even_with_a_summary(self):
        self.assertEqual(a.problem(1, CHECKED.replace('0 errors', '2 errors')), 'astro check exited 1')

    def test_the_summary_must_start_a_line(self):
        self.assertIsNotNone(a.problem(0, 'see "Result (580 files)" below\n'))


class MainTests(unittest.TestCase):
    def run_main(self, script: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = a.main([sys.executable, '-c', script])
        return code, out.getvalue(), err.getvalue()

    def test_passes_through_the_output_and_passes(self):
        code, out, err = self.run_main(f'print({CHECKED!r}, end="")')
        self.assertEqual((code, out, err), (0, CHECKED, ''))

    def test_fails_a_silent_skip_and_says_why(self):
        code, out, err = self.run_main(f'print({MISSING_CHECKER!r}, end="")')
        self.assertEqual(code, 1)
        self.assertEqual(out, MISSING_CHECKER)
        self.assertIn('checked nothing', err)

    def test_stdin_is_closed_so_a_prompt_cannot_wait(self):
        code, _, err = self.run_main('import sys; sys.exit(0 if sys.stdin.read() == "" else 3)')
        self.assertEqual(code, 1)  # exit 0 but no summary
        self.assertIn('checked nothing', err)


if __name__ == '__main__':
    unittest.main()
