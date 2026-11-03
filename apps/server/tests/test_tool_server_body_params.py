"""An OpenAPI tool call keeps a body field that shares its name with a parameter (#189).

The tool's arguments flatten an operation's parameters and its body's
fields into one object. Since #117 every parameter name was taken out of
the body, so `PUT /users/{id}` whose body schema also has (and requires)
`id` was sent without it. A name now leaves the body only when the body
schema does not have it; one in both goes in both places.

Run from apps/server:

    python -m pytest tests/test_tool_server_body_params.py
"""

import asyncio

from local_llm.utils import tools

USERS = {
    'openapi': {
        'paths': {
            '/users/{id}': {
                'put': {
                    'operationId': 'update_user',
                    'parameters': [
                        {'name': 'id', 'in': 'path', 'required': True},
                        {'name': 'notify', 'in': 'query'},
                    ],
                    'requestBody': {'content': {'application/json': {'schema': {'$ref': '#/components/schemas/User'}}}},
                }
            }
        },
        'components': {
            'schemas': {
                'User': {
                    'type': 'object',
                    'required': ['id', 'name'],
                    'properties': {'id': {'type': 'string'}, 'name': {'type': 'string'}},
                }
            }
        },
    }
}


class _Response:
    status = 200
    headers = {'Content-Type': 'application/json'}

    async def json(self):
        return {'ok': True}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _call(monkeypatch, params, server_data=USERS):
    sent = []

    class _Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def put(self, url, **kwargs):
            sent.append((url, kwargs.get('json')))
            return _Response()

    monkeypatch.setattr(tools.aiohttp, 'ClientSession', _Session)
    asyncio.run(tools.execute_tool_server('https://users.test', {}, {}, 'update_user', params, server_data))
    return sent


def test_a_body_field_named_like_a_path_parameter_goes_in_both(monkeypatch):
    sent = _call(monkeypatch, {'id': 'u1', 'name': 'N'})

    assert sent == [('https://users.test/users/u1', {'id': 'u1', 'name': 'N'})]


def test_a_parameter_the_body_schema_lacks_still_stays_out_of_the_body(monkeypatch):
    sent = _call(monkeypatch, {'id': 'u1', 'name': 'N', 'notify': True})

    assert sent == [('https://users.test/users/u1?notify=True', {'id': 'u1', 'name': 'N'})]


def test_an_inline_body_schema_is_read_too(monkeypatch):
    inline = {
        'openapi': {
            'paths': {
                '/users/{id}': {
                    'put': {
                        'operationId': 'update_user',
                        'parameters': [{'name': 'id', 'in': 'path', 'required': True}],
                        'requestBody': {
                            'content': {
                                'application/json': {'schema': {'type': 'object', 'properties': {'id': {}, 'name': {}}}}
                            }
                        },
                    }
                }
            }
        }
    }

    sent = _call(monkeypatch, {'id': 'u1', 'name': 'N'}, inline)

    assert sent == [('https://users.test/users/u1', {'id': 'u1', 'name': 'N'})]


def test_a_malformed_body_has_no_fields_rather_than_failing_the_call():
    assert tools._body_field_names({'requestBody': {'content': 'text/plain'}}, {}) == set()
    assert tools._body_field_names({'requestBody': {'content': {'application/json': {'schema': 'x'}}}}, {}) == set()
    assert tools._body_field_names({}, {}) == set()
