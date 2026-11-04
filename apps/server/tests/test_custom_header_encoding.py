"""A custom header's placeholder is filled with a value a header can carry (#175).

`parse_custom_headers` put `{{USER_NAME}}`, `{{USER_GROUPS}}`, `{{FILE_NAME}}`
and the rest into a connection's custom headers as they were. httpx2 (the MCP
client) refuses a header value it cannot encode as ASCII, so for a user
named "Zoë" every MCP connection with `X-User: {{USER_NAME}}` failed with
"Failed to connect to MCP server". A substituted value that a header cannot
carry (anything but printable ASCII) is now percent-encoded as UTF-8, as the
X-LLLM-User-Name header already is; a plain ASCII value is left exactly as
it was, so existing setups see the same headers. Each group name in
`{{USER_GROUPS}}` is encoded on its own, so the names stay comma-separated.

Run from apps/server:

    python -m pytest tests/test_custom_header_encoding.py
"""

from types import SimpleNamespace

import h11
import httpx2

from local_llm.utils.headers import parse_custom_headers


def _user(name='Ann Lee', email='ann@example.com'):
    return SimpleNamespace(id='u1', name=name, email=email, role='user')


def test_a_non_ascii_user_name_is_percent_encoded():
    headers = parse_custom_headers({'X-User': '{{USER_NAME}}'}, _user('Zoë Ünal'))

    assert headers == {'X-User': 'Zo%C3%AB %C3%9Cnal'}


def test_the_encoded_headers_can_be_sent_by_the_mcp_client():
    headers = parse_custom_headers(
        {'X-User': 'name={{USER_NAME}}', 'X-Groups': '{{USER_GROUPS}}', 'X-File': '{{FILE_NAME}}'},
        _user('Zoë'),
        metadata={'file_name': 'résumé.pdf'},
        user_groups=[SimpleNamespace(id='g1', name='Équipe'), SimpleNamespace(id='g2', name='ops')],
    )

    request = httpx2.Request('GET', 'https://mcp.test', headers=headers)

    assert request.headers['X-User'] == 'name=Zo%C3%AB'
    assert request.headers['X-Groups'] == '%C3%89quipe,ops'
    assert request.headers['X-File'] == 'r%C3%A9sum%C3%A9.pdf'


def test_a_control_character_is_encoded_too():
    headers = parse_custom_headers({'X-Task': '{{TASK}}'}, metadata={'task': 'a\r\nb\tc'})

    assert headers == {'X-Task': 'a%0D%0Ab%09c'}
    # h11, under httpx2, is what refuses a control character, when it writes
    # the request; httpx2.Request alone accepts it.
    h11.Request(method='GET', target='/', headers=[('Host', 'mcp.test'), *headers.items()])


def test_plain_ascii_values_are_left_as_they_were():
    headers = parse_custom_headers(
        {'X-User': '{{USER_NAME}} <{{USER_EMAIL}}>', 'X-Groups': '{{USER_GROUPS}}', 'X-File': '{{FILE_NAME}}'},
        _user("O'Brien & Co, 100%"),
        metadata={'file_name': 'report (final).pdf'},
        user_groups=[SimpleNamespace(id='g1', name='a'), SimpleNamespace(id='g2', name='b')],
    )

    # A % stays as it is too: values that already worked are not changed.
    assert headers == {
        'X-User': "O'Brien & Co, 100% <ann@example.com>",
        'X-Groups': 'a,b',
        'X-File': 'report (final).pdf',
    }


def test_the_configured_text_around_a_placeholder_is_kept():
    headers = parse_custom_headers({'X-User': 'user: {{USER_NAME}}!', 'X-Static': 'fixed'}, _user('Zoë'))

    assert headers == {'X-User': 'user: Zo%C3%AB!', 'X-Static': 'fixed'}
