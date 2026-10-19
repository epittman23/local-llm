"""Which route does GET /id/P/history/diff hit in the real prompts router?"""
from starlette.routing import Match
from local_llm.routers.prompts import router

scope = {'type': 'http', 'path': '/id/P/history/diff', 'method': 'GET', 'root_path': ''}
for r in router.routes:
    m, child = r.matches(scope)
    if m == Match.FULL:
        print('first FULL match:', r.path, r.endpoint.__name__, child.get('path_params'))
        break
