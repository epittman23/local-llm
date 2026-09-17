"""benchmarks/serving/build_info.py - the llama.cpp build string for a run.

Ported from `_vramlog_build` in local-llm's scripts/shell/vram-log.sh (lines
58-81 at the time of the port). Deliberately separate from fingerprint.py:
the build string is recorded against every run but excluded from the
fingerprint on purpose, so a rebuild does not fragment a configuration's
history (see fingerprint.py's module docstring).
"""

from __future__ import annotations

import asyncio
import re

#: Two spellings seen in the wild:
#:   "version: 0.2.0-dev (build 10597, commit 95b8e33e1)"   (current)
#:   "version: 10472 (60eeeb608)"                            (older builds)
_COMMIT_RE = re.compile(r'commit\s+([0-9a-f]{7,})|version:\s*[0-9]+\s*\(([0-9a-f]{7,})\)')
_BUILD_RE = re.compile(r'build\s+([0-9]+)|version:\s*([0-9]+)\s*\(')


def parse_build(version_output: str) -> str:
    """`llama-server --version`'s output -> `"<commit> (<build>)"`, or a
    partial/`"unknown"` fallback, matching the shell's own fallback order.
    """
    commit_match = _COMMIT_RE.search(version_output)
    commit = next((g for g in (commit_match.groups() if commit_match else ()) if g), '') if commit_match else ''
    build_match = _BUILD_RE.search(version_output)
    build = next((g for g in (build_match.groups() if build_match else ()) if g), '') if build_match else ''

    if commit and build:
        return f'{commit} ({build})'
    return commit or build or 'unknown'


async def llama_server_build(llama_bin: str) -> str:
    """Run `<llama_bin>/llama-server --version` and parse its build string.

    Never raises: a build binary that cannot be run or times out reports
    'unknown', matching the shell original's unconditional `echo`.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            f'{llama_bin}/llama-server',
            '--version',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return 'unknown'
    except OSError:
        return 'unknown'
    # Mirrors `head -20`: only the first lines carry the version banner, and
    # a build that prints megabytes of unrelated output should not be
    # scanned in full.
    head = '\n'.join(stdout.decode(errors='replace').splitlines()[:20])
    return parse_build(head)
