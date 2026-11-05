"""The duplicate-content refusal keeps the words the folder sync looks for (#317).

The knowledge base folder sync uploads a modified file while its old copy is
still in the base, and the base refuses text it already holds. The sync tells
that refusal from other failures by "duplicate content" in the message
(`isDuplicateContent` in apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts),
then removes the old copy and uploads again. Reworded without those words,
a file re-saved with the same text would fail on every sync.

Run from apps/server:

    python -m pytest tests/test_duplicate_content_message.py
"""

from local_llm.constants import ERROR_MESSAGES


def test_the_refusal_says_duplicate_content():
    assert 'duplicate content' in ERROR_MESSAGES.DUPLICATE_CONTENT.lower()
