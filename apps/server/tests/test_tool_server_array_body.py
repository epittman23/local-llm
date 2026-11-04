"""An OpenAPI operation whose JSON body is an array makes a usable tool (#191).

The tool's parameters were the array schema itself, `{'type': 'array'}`. That
is not a function schema (a tool's parameters must be an object), and it
dropped the operation's path and query parameters. A model then filled in
an object such as `{'items': [...]}`, which was sent as the body in place of
the array. The array is now offered as one property, `body`, beside the
parameters, and sent on its own as the request body.

Run from apps/server:

    python -m pytest tests/test_tool_server_array_body.py
"""

import asyncio

import pytest

from local_llm.utils import tools

TAG_ARRAY = {'type': 'array', 'items': {'type': 'string'}}


def _spec(schema=None, parameters=(), required=None, method='post'):
    body = {'content': {'application/json': {'schema': schema or {'$ref': '#/components/schemas/Tags'}}}}
    if required is not None:
        body['required'] = required
    return {
        'paths': {
            '/lists/{list_id}/tags': {
                method: {
                    'operationId': 'bulk_add',
                    'parameters': [{'name': 'list_id', 'in': 'path', 'required': True}, *parameters],
                    'requestBody': body,
                }
            }
        },
        'components': {'schemas': {'Tags': TAG_ARRAY}},
    }


def _tool(spec):
    [tool] = tools.convert_openapi_to_tool_payload(spec)
    return tool


class _Response:
    status = 200
    headers = {'Content-Type': 'application/json'}

    async def json(self):
        return {'ok': True}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _call(monkeypatch, params, spec, method='post'):
    sent = []

    class _Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def _request(self, url, **kwargs):
            sent.append((url, kwargs.get('json', 'no body')))
            return _Response()

        post = put = patch = delete = _request

    monkeypatch.setattr(tools.aiohttp, 'ClientSession', _Session)
    result, _ = asyncio.run(
        tools.execute_tool_server('https://lists.test', {}, {}, 'bulk_add', params, {'openapi': spec})
    )
    assert result == {'ok': True}
    return sent


def test_the_tool_takes_an_object_with_the_array_beside_the_parameters():
    parameters = _tool(_spec(required=True))['parameters']

    assert parameters['type'] == 'object'
    assert parameters['properties']['body'] == TAG_ARRAY
    assert 'list_id' in parameters['properties']
    assert sorted(parameters['required']) == ['body', 'list_id']


def test_an_optional_array_body_is_not_required():
    assert _tool(_spec())['parameters']['required'] == ['list_id']


@pytest.mark.parametrize('method', ['post', 'put', 'patch', 'delete'])
def test_the_array_is_sent_as_the_body_itself(monkeypatch, method):
    sent = _call(monkeypatch, {'list_id': 'l1', 'body': ['a', 'b']}, _spec(method=method), method)

    assert sent == [('https://lists.test/lists/l1/tags', ['a', 'b'])]


def test_an_omitted_array_body_sends_no_body(monkeypatch):
    assert _call(monkeypatch, {'list_id': 'l1'}, _spec()) == [('https://lists.test/lists/l1/tags', 'no body')]


def test_a_parameter_named_body_keeps_its_name_and_the_array_takes_another():
    spec = _spec(TAG_ARRAY, parameters=[{'name': 'body', 'in': 'query'}])
    properties = _tool(spec)['parameters']['properties']

    assert properties['body'] == {'type': 'string', 'description': ''}
    assert properties['request_body'] == TAG_ARRAY


def test_with_a_parameter_named_body_the_array_still_goes_in_the_body(monkeypatch):
    spec = _spec(TAG_ARRAY, parameters=[{'name': 'body', 'in': 'query'}])
    sent = _call(monkeypatch, {'list_id': 'l1', 'body': 'q', 'request_body': ['a']}, spec)

    assert sent == [('https://lists.test/lists/l1/tags?body=q', ['a'])]


def test_an_object_body_is_unchanged(monkeypatch):
    spec = _spec({'type': 'object', 'properties': {'tags': TAG_ARRAY}, 'required': ['tags']})
    parameters = _tool(spec)['parameters']

    assert set(parameters['properties']) == {'list_id', 'tags'}
    assert sorted(parameters['required']) == ['list_id', 'tags']
    assert _call(monkeypatch, {'list_id': 'l1', 'tags': ['a']}, spec) == [
        ('https://lists.test/lists/l1/tags', {'tags': ['a']})
    ]


def test_an_array_body_without_items_is_offered_with_any_items():
    """OpenAI refuses an array schema without `items`."""
    assert _tool(_spec({'type': 'array'}))['parameters']['properties']['body'] == {'type': 'array', 'items': {}}


OPTIONAL_TAGS = [
    # FastAPI's `tags: list[str] | None = Body(None)`.
    {'anyOf': [TAG_ARRAY, {'type': 'null'}], 'title': 'Tags'},
    {'oneOf': [{'type': 'null'}, TAG_ARRAY]},
    # OpenAPI 3.1's type list.
    {'type': ['array', 'null'], 'items': {'type': 'string'}},
]


@pytest.mark.parametrize('schema', OPTIONAL_TAGS)
def test_an_optional_array_body_is_offered_as_an_array(schema):
    body = _tool(_spec(schema))['parameters']['properties']['body']

    assert body['type'] == 'array'
    assert body['items'] == {'type': 'string'}


@pytest.mark.parametrize('schema', OPTIONAL_TAGS)
def test_an_optional_array_body_is_sent_as_the_array(monkeypatch, schema):
    sent = _call(monkeypatch, {'list_id': 'l1', 'body': ['a']}, _spec(schema))

    assert sent == [('https://lists.test/lists/l1/tags', ['a'])]


def test_a_union_of_an_array_and_an_object_is_not_read_as_an_array():
    schema = {'anyOf': [TAG_ARRAY, {'type': 'object'}]}

    assert 'body' not in _tool(_spec(schema))['parameters']['properties']
