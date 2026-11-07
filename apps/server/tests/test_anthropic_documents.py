"""Top-level document and search_result blocks survive the Anthropic conversion (#194).

The golden file in test_anthropic_conversion.py pins every other case, so
these expected values are written by hand rather than recorded.
"""

import copy

from local_llm.utils.anthropic import convert_anthropic_to_openai_payload

CACHE = {'type': 'ephemeral'}


def _user_content(*blocks):
    payload = {'messages': [{'role': 'user', 'content': list(blocks)}]}
    before = copy.deepcopy(payload)
    messages = convert_anthropic_to_openai_payload(payload)['messages']
    assert payload == before, 'the input payload must not be mutated'
    assert len(messages) == 1
    assert messages[0]['role'] == 'user'
    return messages[0]['content']


def test_text_document_keeps_its_title_context_and_body_in_order():
    content = _user_content(
        {
            'type': 'document',
            'title': 'Spec',
            'context': 'from the wiki',
            'citations': {'enabled': True},
            'source': {'type': 'text', 'media_type': 'text/plain', 'data': 'body'},
        },
        {'type': 'text', 'text': 'Summarize it.'},
    )
    assert content == [
        {'type': 'text', 'text': '[Document: Spec]\nfrom the wiki\nbody'},
        {'type': 'text', 'text': 'Summarize it.'},
    ]


def test_lone_uncached_document_flattens_to_a_string():
    content = _user_content({'type': 'document', 'source': {'type': 'text', 'data': 'only'}})
    assert content == '[Document: Document]\nonly'


def test_cached_document_keeps_its_cache_control():
    content = _user_content(
        {'type': 'document', 'title': 'T', 'source': {'type': 'text', 'data': 'x'}, 'cache_control': CACHE}
    )
    assert content == [{'type': 'text', 'text': '[Document: T]\nx', 'cache_control': CACHE}]


def test_base64_pdf_becomes_an_explicit_placeholder_without_its_bytes():
    content = _user_content(
        {
            'type': 'document',
            'title': 'Paper',
            'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': 'JVBERi0xLjQK'},
        }
    )
    assert content == (
        '[Document: Paper]\n'
        '[Document content not included: a base64 application/pdf source cannot be passed on as text]'
    )
    assert 'JVBERi0xLjQK' not in content


def test_url_document_placeholder_names_the_url():
    content = _user_content(
        {'type': 'document', 'title': 'Web', 'source': {'type': 'url', 'url': 'https://example.com/a.pdf'}}
    )
    assert content == (
        '[Document: Web]\n[Document content not included: a url source (https://example.com/a.pdf) '
        'cannot be passed on as text]'
    )


def test_file_document_placeholder_names_the_file_id():
    content = _user_content({'type': 'document', 'source': {'type': 'file', 'file_id': 'file_123'}})
    assert content == (
        '[Document: Document]\n[Document content not included: a file source (file_123) cannot be passed on as text]'
    )


def test_content_document_keeps_its_text_and_images_in_order():
    content = _user_content(
        {
            'type': 'document',
            'title': 'Chunks',
            'source': {
                'type': 'content',
                'content': [
                    {'type': 'text', 'text': 'one'},
                    {'type': 'image', 'source': {'type': 'url', 'url': 'https://example.com/i.png'}},
                    {'type': 'text', 'text': 'two'},
                ],
            },
        }
    )
    assert content == [
        {'type': 'text', 'text': '[Document: Chunks]\none'},
        {'type': 'image_url', 'image_url': {'url': 'https://example.com/i.png'}},
        {'type': 'text', 'text': 'two'},
    ]


def test_content_document_joins_adjacent_text_after_a_leading_image():
    content = _user_content(
        {
            'type': 'document',
            'title': 'Figure',
            'source': {
                'type': 'content',
                'content': [
                    {'type': 'image', 'source': {'type': 'url', 'url': 'https://example.com/f.png'}},
                    {'type': 'text', 'text': 'a'},
                    {'type': 'text', 'text': 'b'},
                ],
            },
            'cache_control': CACHE,
        }
    )
    assert content == [
        {'type': 'text', 'text': '[Document: Figure]'},
        {'type': 'image_url', 'image_url': {'url': 'https://example.com/f.png'}},
        {'type': 'text', 'text': 'a\nb', 'cache_control': CACHE},
    ]


def test_content_document_with_a_string_keeps_it():
    content = _user_content({'type': 'document', 'source': {'type': 'content', 'content': 'plain'}})
    assert content == '[Document: Document]\nplain'


def test_search_result_keeps_its_source_title_and_text():
    content = _user_content(
        {
            'type': 'search_result',
            'source': 'https://example.com/doc',
            'title': 'Hit',
            'content': [{'type': 'text', 'text': 'l1'}, {'type': 'text', 'text': 'l2'}],
            'citations': {'enabled': True},
        },
        {'type': 'text', 'text': 'Answer from it.'},
    )
    assert content == [
        {'type': 'text', 'text': '[Search Result: Hit]\nSource: https://example.com/doc\nl1\nl2'},
        {'type': 'text', 'text': 'Answer from it.'},
    ]


def test_cached_search_result_keeps_its_cache_control():
    content = _user_content(
        {'type': 'search_result', 'source': 's', 'title': 't', 'content': [], 'cache_control': CACHE}
    )
    assert content == [{'type': 'text', 'text': '[Search Result: t]\nSource: s', 'cache_control': CACHE}]
