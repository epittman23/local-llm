"""Replays the chat_message usage writes of: reply, continue, then two ordinary chat saves."""
from local_llm.models.chat_messages import ChatMessageTable
from local_llm.models.chats import ChatTable

T = ChatMessageTable
U1 = {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150}
U2 = {'prompt_tokens': 160, 'completion_tokens': 20, 'total_tokens': 180}

history = {'messages': {}}
# placeholder assistant message (main.py _assistant_placeholder)
blob = ChatTable.upsert_message_to_history(history, 'a1', {'role': 'assistant', 'parentId': None, 'content': '', 'done': False})
row = T._build_message('c-a1', 'c', 'u', dict(blob), 1)
print('placeholder           db usage:', row.usage)

# _finish of the first reply: upsert_message_to_chat_by_id_and_message_id(..., {'done', 'output', 'usage': U1})
blob = ChatTable.upsert_message_to_history(history, 'a1', {'done': True, 'usage': U1})
T._apply_message_data(row, dict(blob), 2)
print('after reply           db total_tokens:', row.usage['total_tokens'], '| blob:', blob['usage']['total_tokens'])

# Continue: ResponseStream.usage starts at None, so _finish writes only the continuation's usage
blob = ChatTable.upsert_message_to_history(history, 'a1', {'done': True, 'usage': U2})
T._apply_message_data(row, dict(blob), 3)
print('after continue        db total_tokens:', row.usage['total_tokens'], '| blob:', blob['usage']['total_tokens'])

# Each later POST /chats/{id} reconciles every message (upsert_messages -> _apply_message_data)
for i in range(2):
    T._apply_message_data(row, dict(history['messages']['a1']), 4 + i)
    print(f'after chat save #{i + 1}    db total_tokens:', row.usage['total_tokens'], '| blob:', history['messages']['a1']['usage']['total_tokens'])
