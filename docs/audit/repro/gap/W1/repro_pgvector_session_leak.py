"""PgvectorClient.query()/get() return early on an empty result, before the
'read-only transaction' rollback, so the thread's scoped session keeps its
transaction open and its pooled connection checked out. Run against SQLite
(same SQLAlchemy session/pool code path; only the dialect differs)."""
import logging, os, tempfile
logging.disable(logging.CRITICAL)
from sqlalchemy import create_engine, text
from sqlalchemy.orm import scoped_session, sessionmaker
from sqlalchemy.pool import QueuePool
from local_llm.retrieval.vector.dbs.pgvector import PgvectorClient

path = os.path.join(tempfile.mkdtemp(), 'v.db')
engine = create_engine(f'sqlite:///{path}', poolclass=QueuePool)
with engine.begin() as c:
    c.execute(text('CREATE TABLE document_chunk (id TEXT PRIMARY KEY, vector TEXT, collection_name TEXT, text TEXT, vmetadata TEXT)'))
    c.execute(text("INSERT INTO document_chunk VALUES ('1', NULL, 'has-rows', 't', NULL)"))

client = object.__new__(PgvectorClient)  # skip __init__ (needs Postgres)
client.session = scoped_session(sessionmaker(bind=engine, autoflush=False, expire_on_commit=False))

print('start: checked out =', engine.pool.checkedout())
print('has_collection(has-rows) ->', client.has_collection('has-rows'), '| checked out =', engine.pool.checkedout())
print('query(empty-coll) ->', client.query('empty-coll', {}), '| checked out =', engine.pool.checkedout(),
      '| in transaction =', client.session().in_transaction())
client.session.rollback()
print('get(empty-coll) ->', client.get('empty-coll'), '| checked out =', engine.pool.checkedout(),
      '| in transaction =', client.session().in_transaction())
client.session.rollback()
r = client.query('has-rows', {})
print('query(has-rows) -> ids', r.ids, '| checked out =', engine.pool.checkedout())
