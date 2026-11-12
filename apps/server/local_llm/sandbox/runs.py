"""Where the tag path and the Run endpoint keep each block of code they run in a chat's sandbox.

A `<code_interpreter>` block (utils/middleware.py) or a code block's Run
button (routers/utils.py) is written to `/workspace/.runs/<n>.py` and run
with `python` in the same way the `bash` tool runs a command, so its code is
never a command line (it can be longer than MAX_COMMAND_BYTES) and stays in
the workspace for the model and the user to read again. `n` counts up per
chat: the next number after the highest one already there.
"""

import re
from typing import Final

from local_llm.sandbox.exec import wrap_argv
from local_llm.sandbox.limits import HELPER_TIMEOUT_S
from local_llm.sandbox.manager import SandboxSession
from local_llm.sandbox.types import SandboxError
from local_llm.sandbox.workspace import GUEST_SHELL

#: The directory, under /workspace, that holds the runs.
RUNS_DIR: Final = '/workspace/.runs'

#: Prints the name of each entry in RUNS_DIR ending in `.py` (not hidden), one a line, in the C locale's order;
#: nothing when RUNS_DIR is missing, a symlink, not a directory, or not one UID 1000 can read and search. Only names
#: are read, and the write that follows goes through lllm-path's confinement (sandbox/workspace.py).
LIST_SCRIPT: Final = (
    f'[ -d {RUNS_DIR} ] && [ ! -L {RUNS_DIR} ] && cd {RUNS_DIR} 2>/dev/null || exit 0\n'
    'shopt -s nullglob\n'
    'for f in *.py; do printf \'%s\\n\' "$f"; done\n'
)

_RUN_NAME: Final = re.compile(r'([1-9][0-9]{0,8})\.py')


def list_argv() -> list[str]:
    """The argv that runs LIST_SCRIPT, for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', LIST_SCRIPT, 'lllm-runs'], HELPER_TIMEOUT_S)


def next_number(listing: str) -> int:
    """One more than the highest `<n>.py` in LIST_SCRIPT's output (1 when there is none); other names are ignored."""
    numbers = [int(match.group(1)) for line in listing.split('\n') if (match := _RUN_NAME.fullmatch(line))]
    return max(numbers, default=0) + 1


def run_path(number: int) -> str:
    """The path of run `number`."""
    return f'{RUNS_DIR}/{number}.py'


def run_command(number: int) -> str:
    """The bash command that runs run `number`, from /workspace as the `bash` tool's commands do."""
    return f'python {run_path(number)}'


async def next_run(session: SandboxSession) -> int:
    """The number for the next run in the session's sandbox.

    Raises:
        SandboxError: The sandbox failed, or the listing did not finish.
    """
    result = await session.exec(list_argv(), HELPER_TIMEOUT_S)
    if result.returncode != 0 or result.truncated:
        raise SandboxError(
            f'listing {RUNS_DIR} failed: exit status {result.returncode}, {result.stderr[:200]!r}',
            public=f'{RUNS_DIR} could not be listed',
        )
    return next_number(result.stdout)
