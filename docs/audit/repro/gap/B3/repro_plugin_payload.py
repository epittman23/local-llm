"""B3 repros: plugin.replace_imports substring rewriting, payload stop-sequence mangling."""

import asyncio

from local_llm.utils.payload import apply_model_params_to_body_openai
from local_llm.utils.plugin import load_tool_module_by_id, replace_imports

src = '''from configparser import ConfigParser
from appdirs import user_data_dir
from mainthread import x
from utilsforecast import y
'''
print('[1] replace_imports rewrites third-party imports:')
print(replace_imports(src))

tool_src = '''from configparser import ConfigParser

class Tools:
    def hello(self) -> str:
        """Say hello"""
        return ConfigParser().sections().__class__.__name__
'''


async def main():
    try:
        await load_tool_module_by_id('b3_demo', content=tool_src)
        print('[1b] tool loaded')
    except Exception as e:
        print('[1b] tool using stdlib configparser fails to load:', type(e).__name__, e)


asyncio.run(main())

print('\n[2] stop sequences from a workspace model\'s params (openai router path):')
for stop in (['。'], ['Résumé:'], ['<|im_end|>'], ['\\n\\n']):
    out = apply_model_params_to_body_openai({'stop': list(stop)}, {})
    print(f'    {stop!r:20s} -> {out["stop"]!r}')
print('    string stop (API caller params) ->', apply_model_params_to_body_openai({'stop': 'END'}, {})['stop'])
