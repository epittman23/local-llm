"""Fail unless docs/ROADMAP.md's mermaid block is docs/roadmap-timeline.mmd.

The .mmd file is canonical; ROADMAP.md carries a copy because GitHub cannot
transclude a file into a fenced diagram (AGENTS.md, maintenance policy).
"""

import difflib
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / 'docs'


def embedded_block(markdown: str) -> str:
    lines = markdown.splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if line.rstrip() == '```mermaid') + 1
    end = next(i for i in range(start, len(lines)) if lines[i].rstrip() == '```')
    return ''.join(lines[start:end])


def main() -> int:
    canonical = (DOCS / 'roadmap-timeline.mmd').read_text()
    copy = embedded_block((DOCS / 'ROADMAP.md').read_text())
    if canonical == copy:
        return 0
    sys.stdout.writelines(
        difflib.unified_diff(
            canonical.splitlines(keepends=True),
            copy.splitlines(keepends=True),
            'docs/roadmap-timeline.mmd',
            'docs/ROADMAP.md (mermaid block)',
        )
    )
    print('\nCopy docs/roadmap-timeline.mmd into the mermaid block in docs/ROADMAP.md.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
