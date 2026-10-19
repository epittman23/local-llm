import tempfile, os
os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
from local_llm.benchmarks.evaluation.adapters import load_adapters
from local_llm.benchmarks.evaluation.grading import grade
ad = load_adapters()
mbpp_item = {'task_id': 2, 'test_imports': [], 'test_list': ['assert add(2,2) == 4', 'assert add(1,2) == 3']}
wrong_unittest = '''```python
import unittest
def add(a, b):
    return a - b   # WRONG

class T(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(add(0, 0), 0)

if __name__ == "__main__":
    unittest.main()
```'''
print('mbpp wrong+unittest.main ->', grade(ad['mbpp'], mbpp_item, wrong_unittest))
wrong_plain = wrong_unittest.split('class T')[0] + '```'
print('mbpp wrong plain       ->', grade(ad['mbpp'], mbpp_item, wrong_plain))
he_item = {'task_id':'HumanEval/x','entry_point':'add','prompt':'def add(a, b):\n    """add"""\n','test':'def check(c):\n    assert c(2,2)==4\n'}
print('humaneval wrong+exit  ->', grade(ad['humaneval'], he_item, '```python\nimport sys\ndef add(a,b):\n    return 0\nif __name__ == "__main__":\n    print(add(1,2)); sys.exit(0)\n```'))
