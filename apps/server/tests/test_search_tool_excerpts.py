"""Search tool excerpts keep the match when lowering lengthens the text (#646).

search_chats, search_notes and search_channel_messages found the match in the
lower-cased text and cut the original at that index. U+0130 lowers to two code
points, so with 50 or more of them before the match the excerpt missed it
(#339 fixed the same fault in the chat list). They share find_in_lowered now.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_search_tool_excerpts.py
"""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.users import Users
from local_llm.tools import builtin
from local_llm.utils.misc import find_in_lowered

REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
DOTTED = 'İ' * 60


def _run(coro):
    return asyncio.run(coro)


def _user() -> str:
    uid = f'excerpt-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    return uid


def _text(word: str) -> str:
    return f'{DOTTED} {word} and the rest of it'


def test_search_chats_excerpt_holds_the_match():
    uid, word = _user(), f'zebrafish{uuid.uuid4().hex[:6]}'
    messages = {'m1': {'role': 'user', 'content': _text(word)}}
    chat = {'title': 'about fish', 'history': {'messages': messages}, 'messages': list(messages.values())}
    _run(Chats.insert_new_chat(str(uuid.uuid4()), uid, ChatForm(chat=chat)))

    found = json.loads(_run(builtin.search_chats(word, __request__=REQUEST, __user__={'id': uid})))

    assert len(found) == 1
    assert word in found[0]['snippet']


def test_search_notes_excerpt_holds_the_match():
    uid, word = _user(), f'zebrafish{uuid.uuid4().hex[:6]}'
    _run(Notes.insert_new_note(uid, NoteForm(title='fish', data={'content': {'md': _text(word)}})))

    found = json.loads(_run(builtin.search_notes(word, __request__=REQUEST, __user__={'id': uid})))

    assert len(found) == 1
    assert word in found[0]['snippet']


def test_search_channel_messages_excerpt_holds_the_match():
    async def scenario():
        tag = uuid.uuid4().hex[:8]
        word = f'zebrafish{tag}'
        user = await Users.insert_new_user(f'u{tag}', 'Una', f'u{tag}@example.invalid', role='admin')
        assert user is not None
        form = CreateChannelForm(
            type='',
            name=f'fish-{tag}',
            access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
        )
        channel = await Channels.insert_new_channel(form, user.id)
        assert channel is not None
        await Messages.insert_new_message(MessageForm(content=_text(word)), channel.id, user.id)
        out = await builtin.search_channel_messages(word, __request__=REQUEST, __user__={'id': user.id})
        return word, json.loads(out)

    word, found = _run(scenario())

    assert len(found) == 1
    assert word in found[0]['content_snippet']


def test_find_in_lowered_maps_back_after_lengthening_characters():
    text = f'{DOTTED}Needle here'

    start, end = find_in_lowered(text, 'needle')

    assert text[start:end] == 'Needle'


def test_find_in_lowered_without_lengthening_is_plain():
    assert find_in_lowered('Say NEEDLE twice', 'needle') == (4, 10)


def test_find_in_lowered_without_a_match_is_none():
    assert find_in_lowered(f'{DOTTED} nothing', 'needle') is None


def test_find_in_lowered_needle_with_lengthening_characters():
    text = f'{DOTTED}x İzmir y'

    start, end = find_in_lowered(text, 'İzmir'.lower())

    assert text[start:end] == 'İzmir'


def test_find_in_lowered_match_at_the_very_end():
    text = f'{DOTTED}Needle'

    start, end = find_in_lowered(text, 'needle')

    assert (text[start:end], end) == ('Needle', len(text))


def test_find_in_lowered_needle_ending_inside_a_lengthened_character_takes_all_of_it():
    # 'İ' lowers to 'i' + U+0307: a needle ending on the 'i' still covers the whole 'İ'.
    text = 'abİc'

    assert find_in_lowered(text, 'abi') == (0, 3)


def test_find_in_lowered_needle_starting_inside_a_lengthened_character_starts_at_it():
    text = 'abİc'

    assert find_in_lowered(text, '̇c') == (2, 4)


def test_find_in_lowered_empty_needle_and_empty_text():
    assert find_in_lowered(f'{DOTTED}x', '') == (0, 0)
    assert find_in_lowered('', '') == (0, 0)
    assert find_in_lowered('', 'needle') is None


def test_search_notes_excerpt_centres_on_a_later_word_when_the_first_is_absent():
    # The query matches the note by its title; its text holds only the second word.
    uid, word = _user(), f'zebrafish{uuid.uuid4().hex[:6]}'
    query = f'nosuchword {word}'
    _run(Notes.insert_new_note(uid, NoteForm(title=query, data={'content': {'md': _text(word)}})))

    found = json.loads(_run(builtin.search_notes(query, __request__=REQUEST, __user__={'id': uid})))

    assert [word in note['snippet'] for note in found] == [True]
