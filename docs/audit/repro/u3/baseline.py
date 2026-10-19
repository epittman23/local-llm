import stub
from local_llm.benchmarks.analysis.compare import group_records, rows_for
def rec(cfg,tier,i,ok): return dict(model='m',config_id=cfg,tier=tier,benchmark='mbpp',item_id=str(i),outcome='pass' if ok else 'fail_assert',wall_ms=1000)
R=[rec('A','smoke',i,i<12) for i in range(24)]+[rec('A','full',i,i<500) for i in range(1000)]+[rec('B','full',i,i<600) for i in range(1000)]+[rec('B','smoke',i,i<20) for i in range(24)]
for r in rows_for(group_records(R),{},baseline='A'):
    print(r['config_id'],r['tier'],r['passed'],r['attempted'],'vs',r.get('vs_baseline'),r.get('vs_baseline_note',''))
