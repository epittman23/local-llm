"""Repro: chat_search_snippet finds the match in content.lower() but slices content.

'İ' (U+0130) lowers to two code points, so each one before the match shifts
the window right by one character; past ~106 of them the snippet no longer
contains the match at all.
"""
from local_llm.routers.chats import chat_search_snippet

content = 'İ' * 150 + ' needle ' + 'filler ' * 100
chat = {'history': {'messages': {'m1': {'role': 'user', 'content': content}}}}
snippet = chat_search_snippet(chat, 'needle')
print(repr(snippet[:80]))
print('match in snippet:', 'needle' in snippet)
