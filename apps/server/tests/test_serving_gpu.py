"""benchmarks/serving/gpu.py: one nvidia-smi reading, as the recorder and the pre-screen take it.

A fake nvidia-smi (a script printing a fixed row) stands in for the card.

Run from apps/server:

    python -m pytest tests/test_serving_gpu.py
"""

from __future__ import annotations

import sys

import pytest

from local_llm.benchmarks.serving.gpu import SMI_FIELDS, sample_gpu


def _smi(tmp_path, body: str, code: int = 0) -> str:
    path = tmp_path / 'nvidia-smi'
    path.write_text(f'#!{sys.executable}\nimport sys\nprint({body!r})\nsys.exit({code})\n')
    path.chmod(0o755)
    return str(path)


def test_a_full_row(tmp_path):
    sample = sample_gpu(_smi(tmp_path, '61, 97, 5123, 6144, 78.25, 1702, 0x0000000000000004'))
    assert sample is not None
    assert {k: v for k, v in sample.items() if k != 'at'} == {
        'temp_c': 61,
        'util_pct': 97,
        'mem_used_mib': 5123,
        'mem_total_mib': 6144,
        'power_w': 78.25,
        'sm_mhz': 1702,
        'throttle': 4,
    }


def test_a_laptop_without_a_sensor_reads_none_for_that_field(tmp_path):
    sample = sample_gpu(_smi(tmp_path, '[N/A], 12, 300, 6144, [N/A], 210, [N/A]'))
    assert sample is not None
    assert (sample['temp_c'], sample['power_w'], sample['throttle']) == (None, None, None)
    assert sample['mem_used_mib'] == 300


@pytest.mark.parametrize(('body', 'code'), [('61, 97', 0), ('', 0), ('61, 97, 5123, 6144, 78.25, 1702, 0x4', 9)])
def test_a_short_empty_or_failed_reading_is_skipped(tmp_path, body, code):
    assert sample_gpu(_smi(tmp_path, body, code)) is None


def test_no_nvidia_smi_is_skipped(tmp_path):
    assert sample_gpu(str(tmp_path / 'missing')) is None


def test_the_query_is_the_recorders():
    from local_llm.benchmarks.serving import telemetry_recorder

    assert telemetry_recorder.sample_gpu is sample_gpu
    assert SMI_FIELDS.split(',')[-1] == 'clocks_throttle_reasons.active'
