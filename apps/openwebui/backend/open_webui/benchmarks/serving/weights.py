"""benchmarks/serving/weights.py - download a profile's model weights.

Ported from `lllm-fetch` in local-llm's scripts/shell/main.sh (lines 277-292
at the time of the port). Not test data: the benchmark datasets fetch
themselves, independently, into the fork's own DATA_DIR (see
docs/CLAUDE.md); this is the GGUF a serving profile points at.

Per docs/migration-plan.md's "Assumptions requiring confirmation" section,
this is meant to back a "Download weights" action on the Serve page (a
backend endpoint, Phase 5's UI) rather than be called directly -- hence
`FetchProcess` following the same start()/lines()/wait() shape as
benchmarks/proc.py's `Command` and launcher.py's `ServeProcess`, so a router
can stream its progress the same way it already streams a server's log.
"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from pathlib import Path

from open_webui.benchmarks.serving.launcher import resolve_model_path
from open_webui.benchmarks.serving.profiles import ServingProfile


class WeightsError(RuntimeError):
    """No 'hf' CLI, a profile with nothing to fetch, or a failed download."""


def fetch_argv(profile: ServingProfile, *, llama_models: str | None = None) -> list[str]:
    """The `hf download` argv (without the `hf` executable itself) for a profile.

    Targets the resolved model path's own directory under LLAMA_MODELS, not
    wherever a caller happens to run from -- on WSL2 that directory must stay
    off `/mnt/c`: writes there cross the 9p filesystem and are dramatically
    slower than a Linux-native path. LLAMA_MODELS defaults to `$HOME/models`
    (see launcher.resolve_model_path) precisely so a Windows-side path is
    never the default target.
    """
    if not profile.hf_repo:
        raise WeightsError(f'profile {profile.name!r} has no hf_repo to fetch')
    model_path = resolve_model_path(profile.model_path, llama_models=llama_models)
    target_dir = str(Path(model_path).parent)
    return [
        'download',
        profile.hf_repo,
        '--local-dir',
        target_dir,
        '--include',
        profile.hf_pattern,
    ]


@dataclass
class FetchProcess:
    """One `hf download` invocation for a profile's weights."""

    profile: ServingProfile
    llama_models: str | None = None
    proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        hf = shutil.which('hf')
        if hf is None:
            raise WeightsError('\'hf\' CLI not found. Install with: pip install -U "huggingface_hub[cli]"')
        argv = fetch_argv(self.profile, llama_models=self.llama_models)
        self.proc = await asyncio.create_subprocess_exec(
            hf,
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

    async def lines(self):
        """Stream stdout line by line. One pass, safe to iterate once."""
        if self.proc is None or self.proc.stdout is None:
            return
        async for raw in self.proc.stdout:
            yield raw.decode(errors='replace').rstrip()

    async def wait(self) -> int:
        """Wait for the download to finish, raising on a non-zero exit."""
        if self.proc is None:
            raise WeightsError('start() was never called')
        rc = await self.proc.wait()
        if rc != 0:
            raise WeightsError(f'hf download exited {rc}')
        return rc

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None
