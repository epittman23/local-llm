"""benchmarks/serving/model_name.py - split a GGUF basename into name/quant.

Ported from `_vramlog_split_model` in local-llm's scripts/shell/vram-log.sh
(lines 87-102 at the time of the port). These were the two halves of the old
per-model log filename; they are now columns on the run row.
"""

from __future__ import annotations

import re

#: A field that looks like a quantization label: UD, a leading Q/IQ digit,
#: BF16, F16, F32 -- exactly the shell's `^(UD|I?Q[0-9]|BF16|F16|F32)$` plus
#: its second, looser `^I?Q[0-9]` alternative (which the first pattern
#: already subsumes for a whole-field match, so one regex covers both).
_QUANT_FIELD_RE = re.compile(r'^(UD|I?Q[0-9]|BF16|F16|F32)')


def split_model(basename: str) -> tuple[str, str]:
    """`"Qwen3.8-27B-UD-Q3_K_XL"` -> `("Qwen3.8-27B", "UD-Q3_K_XL")`.

    The quant is the first '-'-separated field that looks like one. A
    basename with no such field returns itself as the name and `"unknown"`
    as the quant, matching the shell's fallback exactly.
    """
    fields = basename.split('-')
    for i, field in enumerate(fields):
        if _QUANT_FIELD_RE.match(field):
            return '-'.join(fields[:i]), '-'.join(fields[i:])
    return basename, 'unknown'
