import sys, types
class _A:
    def __getattr__(self, n): return type(n,(),{})
for m in ['local_llm.models.benchmarks.configs','local_llm.models.benchmarks.telemetry','local_llm.models.benchmarks.tests','local_llm.models.benchmarks','local_llm.models']:
    mod=types.ModuleType(m); mod.__getattr__=lambda n: type(n,(),{}); sys.modules[m]=mod
