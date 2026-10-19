from local_llm.benchmarks.evaluation.adapters import load_adapters
from local_llm.benchmarks.evaluation.grading import grade
ad = load_adapters()
item = {'task_id': 2, 'test_imports': [], 'test_list': ['assert add(2,2) == 4']}
ans = '```python\ndef add(a, b):\n    return a + b\n\nif __name__ == "__main__":\n    a, b = map(int, input().split())\n    print(add(a, b))\n```'
print('mbpp CORRECT + __main__ input() ->', grade(ad['mbpp'], item, ans))
