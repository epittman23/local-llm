"""The Knowledge page's "local" source filter lists bases made in the app (#197).

insert_new_knowledge stores meta as JSON null, and the filter tested SQL
NULL (meta IS NULL OR meta->>'source' != 'external'), which is NULL for
those rows, so "local" listed nothing.

Runs against the suite's temporary SQLite database (migrated on import).

Run from apps/server:

    python -m pytest tests/test_knowledge_source_filter.py
"""

import asyncio
import uuid

from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users


def _ids(result) -> set[str]:
    return {k.id for k in result.items}


def test_local_lists_bases_made_in_the_app_and_external_lists_the_others():
    async def scenario():
        tag = uuid.uuid4().hex[:8]
        user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
        made = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
        external = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Wiki', description=''))
        await Knowledges.update_knowledge_meta_by_id(external.id, {'source': 'external'})
        sourceless = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Misc', description=''))
        await Knowledges.update_knowledge_meta_by_id(sourceless.id, {})
        base = {'user_id': user.id, 'group_ids': []}
        local = await Knowledges.search_knowledge_bases(user.id, {**base, 'source': 'local'})
        ext = await Knowledges.search_knowledge_bases(user.id, {**base, 'source': 'external'})
        return made, external, sourceless, local, ext

    made, external, sourceless, local, ext = asyncio.run(scenario())

    assert {made.id, sourceless.id} <= _ids(local) and external.id not in _ids(local)
    assert _ids(ext) == {external.id}
