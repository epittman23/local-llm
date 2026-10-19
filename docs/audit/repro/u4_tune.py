import asyncio, math, time, types
from local_llm.benchmarks.tuning import tune
from local_llm.benchmarks.tuning.tune_schedule import Candidate, log_ratios, sign_test

def mk(sha_hint, base=False):
    c = Candidate('p', {} if base else {'LLAMA_THREADS': sha_hint}, stage='explore', baseline=base)
    return c

base = mk(None, True); A = mk('4'); B = mk('6'); C = mk('8'); D = mk('10')
items = [('b', str(i)) for i in range(6)]

async def fake_set(*a, **k): pass
tune.BenchmarkTuneCandidates.set_candidate = staticmethod(fake_set)

def run_elim(matrix, alive):
    s = tune.Sweep.__new__(tune.Sweep)
    s.sweep_id='x'; s.baseline=base; s.candidates={c.sha:c for c in alive}
    s.o = types.SimpleNamespace(eta=2)
    async def tm(sweep_id, rnd=None, counted_only=True): return matrix
    tune.tune_matrix = tm
    return asyncio.run(s.eliminate(1, alive)), s

# 1. score exactly 0 ranks below a negative score
m = {}
for b,i in items:
    m[(b,i,base.sha)] = {'gen_tps': 10.0}
    m[(b,i,A.sha)] = {'gen_tps': 10.0}       # identical to baseline: score 0.0
    m[(b,i,B.sha)] = {'gen_tps': 5.0}        # 50% slower
    m[(b,i,C.sha)] = {'gen_tps': 4.0}
(surv, dec), s = run_elim(m, [base, A, B, C])
print('1. survivors', [c.label if c.baseline else ('A' if c is A else 'B' if c is B else 'C') for c in surv], dec)

# 2. best() returns a candidate slower than baseline
async def sc(rnd): return {base.sha:(0.0,6), B.sha:(math.log(0.5),6), C.sha:(math.log(0.4),6)}
s.scores = sc
print('2. best() =', 'B' if asyncio.run(s.best([base,B,C])) is B else 'other', 'with score', math.log(0.5))

# 3. sign test zip misalignment
m = {}
for k,(b,i) in enumerate(items):
    m[(b,i,base.sha)] = {'gen_tps': 10.0}
    m[(b,i,A.sha)] = {'gen_tps': 12.0 + k}           # all 6 items
    if k != 0: m[(b,i,B.sha)] = {'gen_tps': 11.0+k}  # missing item 0
la = log_ratios(m, A.sha, base.sha, items); lb = log_ratios(m, B.sha, base.sha, items)
aligned = [math.log((12+k)/10)-math.log((11+k)/10) for k in range(1,6)]
zipped = [a-b for a,b in zip(la,lb)]
print('3. aligned diffs', [round(x,3) for x in aligned], sign_test(aligned))
print('   zipped  diffs', [round(x,3) for x in zipped], sign_test(zipped))

# 4. cooldown total_seconds
s2 = types.SimpleNamespace(sweep_id='x', budget=types.SimpleNamespace(seconds=10000), baseline_tps=10.0, last_pause_at=None)
o = types.SimpleNamespace(cooldown_temp=50, cooldown_max=1, cooldown_attempts=2, drift_tolerance=0.15, max_cooldown_share=0.35)
cd = tune.Cooldown(s2, o)
async def nothing(*a, **k): return None
cd.gpu.read = nothing
async def op(*a, **k): return 1
tune.BenchmarkTunePauses.open_pause = staticmethod(op); tune.BenchmarkTunePauses.close_pause = staticmethod(nothing)
async def w(t, win): await asyncio.sleep(0.2)
cd._wait = w; cd._probe = nothing
cd.total_seconds = 3000.0
asyncio.run(cd.run(trigger='drift', rnd=1, visit_id=None, drift_ratio=None))
print('4. total_seconds after a ~0.4s pause starting from 3000:', round(cd.total_seconds,2))
