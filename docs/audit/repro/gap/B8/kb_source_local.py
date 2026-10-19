"""Does the Knowledge page's 'local' source filter match a knowledge base created through insert_new_knowledge?"""
import time
from sqlalchemy import create_engine, or_, select, func
from sqlalchemy.orm import Session
from sqlalchemy.dialects import postgresql
from local_llm.models.knowledge import Knowledge, KnowledgeModel, KnowledgeForm

engine = create_engine('sqlite://')
Knowledge.__table__.create(engine)

# Exactly how insert_new_knowledge builds the row (knowledge.py:206-218): meta=None is passed explicitly.
form = KnowledgeForm(name='notes', description='d')
km = KnowledgeModel(**{**form.model_dump(exclude={'access_grants'}), 'id': 'k1', 'user_id': 'u',
                       'created_at': int(time.time()), 'updated_at': int(time.time()), 'access_grants': []})
with Session(engine) as s:
    s.add(Knowledge(**km.model_dump(exclude={'access_grants'})))
    s.commit()
    print('stored meta column:', s.execute(select(func.quote(Knowledge.meta))).scalar())
    local = or_(Knowledge.meta.is_(None), Knowledge.meta['source'].as_string() != 'external')  # knowledge.py:297-302
    print('rows matching source=local:', s.execute(select(func.count()).select_from(Knowledge).where(local)).scalar())
    print('rows total:', s.execute(select(func.count()).select_from(Knowledge)).scalar())
print('postgres SQL for the filter:', select(Knowledge.id).where(local).compile(dialect=postgresql.dialect()))
