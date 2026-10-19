import asyncio, time
from local_llm.benchmarks.evaluation.adapters import load_adapters
from local_llm.benchmarks.evaluation.grading import grade
ad = load_adapters()
item = {'task_id': 2, 'test_imports': [], 'test_list': ['assert f() == 1']}
slow = '```python\nimport time\ndef f():\n    time.sleep(3); return 1\n```'
async def ticker():
    last = time.monotonic(); worst = 0
    for _ in range(40):
        await asyncio.sleep(0.1); now = time.monotonic(); worst = max(worst, now-last); last = now
    print(f'max gap between 100ms ticks: {worst:.2f}s')
async def main():
    t = asyncio.create_task(ticker()); await asyncio.sleep(0.2)
    print(grade(ad['mbpp'], item, slow))  # same call shape as runner.run_item line 352
    await t
asyncio.run(main())
