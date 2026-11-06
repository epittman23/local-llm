"""A synthetic llama-bench JSONL line, for the pre-screen's tests.

**Synthetic, not recorded on this machine**: the fields are llama-bench's
`test::get_fields()` list at llama.cpp f0fb5984b (build 11875,
tools/llama-bench/llama-bench.cpp), in its order, with made-up values. No
model has been benchmarked to produce it.

No imports from the app: the fake llama-bench (prescreen_stubs.py) imports
this from a subprocess.
"""

import json

#: llama-bench's JSONL fields at f0fb5984b, in its order.
FIELDS = [
    'build_commit',
    'build_number',
    'cpu_info',
    'gpu_info',
    'backends',
    'model_filename',
    'model_type',
    'model_size',
    'model_n_params',
    'n_batch',
    'n_ubatch',
    'n_threads',
    'cpu_mask',
    'cpu_strict',
    'poll',
    'type_k',
    'type_v',
    'n_gpu_layers',
    'n_cpu_moe',
    'split_mode',
    'main_gpu',
    'no_kv_offload',
    'flash_attn',
    'devices',
    'tensor_split',
    'tensor_buft_overrides',
    'load_mode',
    'lazy_mode',
    'embeddings',
    'no_op_offload',
    'no_host',
    'repack',
    'fit_target',
    'fit_min_ctx',
    'n_prompt',
    'n_gen',
    'n_depth',
    'test_time',
    'avg_ns',
    'stddev_ns',
    'avg_ts',
    'stddev_ts',
]


def jsonl_line(
    *,
    n_prompt: int,
    n_gen: int,
    avg_ts: float,
    ngl: int = 99,
    moe: int = 0,
    batch: int = 512,
    ubatch: int = 512,
    threads: int = 6,
    type_k: str = 'q8_0',
    type_v: str = 'q8_0',
) -> str:
    """One synthetic llama-bench JSONL line (see the module docstring)."""
    values = {
        'build_commit': 'f0fb5984b',
        'build_number': 11875,
        'cpu_info': 'Synthetic CPU',
        'gpu_info': 'Synthetic GPU 6GB',
        'backends': 'CUDA',
        'model_filename': '/models/model.gguf',
        'model_type': 'synthetic 7B Q4_K - Medium',
        'model_size': 4683073536,
        'model_n_params': 7615616512,
        'n_batch': batch,
        'n_ubatch': ubatch,
        'n_threads': threads,
        'cpu_mask': '0x0',
        'cpu_strict': False,
        'poll': 50,
        'type_k': type_k,
        'type_v': type_v,
        'n_gpu_layers': ngl,
        'n_cpu_moe': moe,
        'split_mode': 'layer',
        'main_gpu': 0,
        'no_kv_offload': False,
        'flash_attn': 1,
        'devices': 'auto',
        'tensor_split': '0.00',
        'tensor_buft_overrides': 'none',
        'load_mode': 'mmap',
        'lazy_mode': 'auto',
        'embeddings': False,
        'no_op_offload': 0,
        'no_host': False,
        'repack': True,
        'fit_target': 0,
        'fit_min_ctx': 0,
        'n_prompt': n_prompt,
        'n_gen': n_gen,
        'n_depth': 0,
        'test_time': '2026-10-28T00:00:00Z',
        'avg_ns': int(1e9 * max(n_prompt, n_gen) / avg_ts),
        'stddev_ns': 1000,
        'avg_ts': avg_ts,
        'stddev_ts': avg_ts * 0.02,
    }
    row = {k: values[k] for k in FIELDS}
    samples = [avg_ts * f for f in (0.98, 1.0, 1.02)]
    return json.dumps({**row, 'samples_ns': [values['avg_ns']] * 3, 'samples_ts': samples}, separators=(', ', ': '))
