"""Run `bunx astro check` and fail unless it really checked the project.

`astro check` exits 0 when it cannot load `@astrojs/check`: it prints that
the package is required and stops without checking a file. From #768
(2026-11-06) to the fix that added this script, CI's step passed that way
(an `@emnapi/runtime` that did not match `@emnapi/core` kept the checker
from loading). So a run passes only when the command exits 0 *and* prints
its summary (`Result (N files):`).

CI's Web job and `make test-web` both run it from apps/web:
`python3 ../../.github/scripts/astro_check.py`.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

COMMAND = ['bunx', 'astro', 'check']
SUMMARY = re.compile(r'^Result \(\d+ files?\)', re.MULTILINE)
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


def problem(returncode: int, output: str) -> str | None:
    """Why the run fails, or None when it passed."""
    if returncode != 0:
        return f'astro check exited {returncode}'
    if not SUMMARY.search(ANSI.sub('', output)):
        return (
            'astro check exited 0 but printed no "Result (N files)" summary, so it checked nothing '
            '(it does this when it cannot load @astrojs/check; the output above says why)'
        )
    return None


def main(command: list[str] | None = None) -> int:
    # stdin closed: with a terminal attached, astro check offers to install
    # the missing package and waits for an answer.
    proc = subprocess.run(
        command or COMMAND, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    sys.stdout.write(proc.stdout)
    reason = problem(proc.returncode, proc.stdout)
    if reason is None:
        return 0
    print(f'::error::{reason}' if os.environ.get('GITHUB_ACTIONS') else reason, file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
