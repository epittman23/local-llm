"""A chat search snippet shows the match (#339).

The snippet's window was placed by an index found in `content.lower()` and
used on `content`. Lowering lengthens some characters (U+0130, İ, becomes
two code points), so with enough of them before the match the window
missed it. It is now found in the text itself, case-insensitively.

Run from apps/server:

    python -m pytest tests/test_chat_search_snippet.py
"""

from local_llm.routers.chats import chat_search_snippet


def _chat(*contents):
    return {'history': {'messages': {str(i): {'content': c} for i, c in enumerate(contents)}}}


def test_the_snippet_holds_the_match_after_characters_that_lengthen_when_lowered():
    content = 'İ' * 150 + ' the needle is here ' + 'x' * 300

    snippet = chat_search_snippet(_chat(content), 'needle')

    assert snippet is not None and 'needle' in snippet


def test_a_match_in_other_case_is_found_and_shown_as_written():
    snippet = chat_search_snippet(_chat('Notes about the NEEDLE in the haystack'), 'needle')

    assert snippet == 'Notes about the NEEDLE in the haystack'


def test_a_search_term_is_looked_for_when_the_whole_text_matches_nowhere():
    # The whole text matches nowhere, so the snippet comes from one of its terms.
    snippet = chat_search_snippet(_chat('first message', 'about haystacks'), 'needle haystacks')

    assert snippet == 'about haystacks'


def test_no_match_gives_no_snippet():
    assert chat_search_snippet(_chat('nothing here'), 'needle') is None
