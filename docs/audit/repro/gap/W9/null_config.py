"""A tool-server connection the save endpoint accepts with config null, then main.py:559 at the next startup."""
from local_llm.routers.configs import ToolServersConfigForm

form = ToolServersConfigForm(TOOL_SERVER_CONNECTIONS=[{'url': 'https://example.com', 'path': 'openapi.json', 'auth_type': 'none', 'key': None, 'config': None}])
connections = [c.model_dump() for c in form.TOOL_SERVER_CONNECTIONS]  # what configs.py:256 persists
print('persisted:', connections)
try:
    any('access_control' in c.get('config', {}) for c in connections)  # main.py:559
except Exception as e:
    print('startup would fail:', type(e).__name__, e)
