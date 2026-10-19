"""What type does psycopg3 send for the query vector in external._retrieve_pgvector?
The embedding function returns a Python list; pgvector.psycopg.register_vector only
registers dumpers for pgvector.Vector and numpy.ndarray (not list)."""
import psycopg
from psycopg.adapt import AdaptersMap, Transformer, PyFormat
from psycopg.types import TypeInfo
from pgvector.psycopg.vector import register_vector_info

class Ctx:  # minimal stand-in for a connection context
    def __init__(self):
        self.adapters = AdaptersMap(psycopg.adapters)
        self.connection = None

ctx = Ctx()
info = TypeInfo('vector', 99999, 99998)  # fake oids for the vector type
register_vector_info(ctx, info)
tx = Transformer(ctx)
emb = [0.1, 0.2, 0.3]  # what embedding_function returns (a list)
for fmt in (PyFormat.AUTO, PyFormat.TEXT, PyFormat.BINARY):
    d = tx.get_dumper(emb, fmt)
    print(fmt.name, 'dumper', type(d).__name__, 'oid', d.oid,
          '(1022 = float8[]; 99999 = vector)')
import numpy as np
print('ndarray oid', tx.get_dumper(np.array(emb), PyFormat.AUTO).oid)
