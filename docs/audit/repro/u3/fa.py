import stub
from local_llm.benchmarks.analysis.compare import flags_of, differing
a=['arch: moe | ngl: 99 | ctx: 65536 (total) | parallel: 1 | threads: 6 | moe: 34','override-tensors: n/a','speculative: off','cache: k=q8_0 v=q8_0 | fa: on | batch: 2048 | ubatch: 512']
b=list(a); b[3]='cache: k=q8_0 v=q8_0 | fa: off | batch: 2048 | ubatch: 512'
print(flags_of(a)); print('differing:',differing(flags_of(a),flags_of(b)))
