import stub, math
from local_llm.benchmarks.analysis import report as R
from scipy import stats as sps
# stats sanity
print('wilson 8/8', R.wilson(8,8), 'wilson 3/10', R.wilson(3,10))
print('mcnemar b=0 c=10', R.mcnemar_exact(0,10), 'ref', sps.binomtest(0,10).pvalue)
print('holm', R.holm([0.01,0.04,0.03]), 'ref [0.03,0.06,0.06]')
# block: baseline (none) fails all 12 items, prompt "p" passes all
recs=[]
for i in range(12):
    recs.append(dict(model='m',config_id='c',tier='t',benchmark='mbpp',adapter_sha='a',system_sha=None,item_id=str(i),outcome='fail_assert',at=100+i))
    recs.append(dict(model='m',config_id='c',tier='t',benchmark='mbpp',adapter_sha='a',system_sha='abcdef',system_name='p',item_id=str(i),outcome='pass',at=200+i))
blocks=R.blocks_of(recs)
class F:
    def __getattr__(self,n): return lambda *a,**k: None
text,results=R.section_accuracy(blocks,F(),R.Audit())
r=results[0]; print('q',r['q'],'p_perm',r['p_perm'])
print([l for l in text.split('\n') if 'Verdict' in l or 'Holm' in l][:3])
print(R.headline(results, 0.5, R.Audit(), blocks))
