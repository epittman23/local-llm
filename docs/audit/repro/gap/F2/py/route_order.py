from starlette.routing import Match
from local_llm.routers.prompts import router
scope = {'type': 'http', 'path': '/id/abc/history/diff', 'method': 'GET'}
for r in router.routes:
    m, _ = r.matches(scope)
    if m == Match.FULL:
        print('first full match:', r.path, r.endpoint.__name__)
        break
