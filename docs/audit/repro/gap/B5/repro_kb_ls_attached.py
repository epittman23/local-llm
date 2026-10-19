"""Repro: kb_exec ls lists a model's directly attached file inside every knowledge base's root."""
import asyncio
from types import SimpleNamespace as NS
import local_llm.models.knowledge as mk
import local_llm.models.files as mf
import local_llm.models.groups as mg
import local_llm.models.access_grants as ma
from local_llm.tools.knowledge_fs import kb_exec

def fm(id, name):
    return NS(id=id, filename=name, meta={'size': 10}, updated_at=1700000000, created_at=1700000000, data={'content': 'x'})

KB = {'kb1': NS(id='kb1', name='Docs', description='', user_id='u1'), 'kb2': NS(id='kb2', name='Specs', description='', user_id='u1')}
FILES = {'f1': fm('f1', 'guide.md'), 'f2': fm('f2', 'spec.md'), 'fa': fm('fa', 'attached.csv')}

class K:
    async def get_knowledge_by_id(self, id): return KB.get(id)
    async def get_files_with_directory_ids(self, kid): return [(FILES['f1'] if kid == 'kb1' else FILES['f2'], None)]
    async def get_directories(self, kid, parent_id=None): return []
class F:
    async def get_file_by_id(self, id): return FILES.get(id)
class G:
    async def get_groups_by_member_id(self, uid, db=None): return []
class A:
    async def has_access(self, **kw): return False

mk.Knowledges, mf.Files, mg.Groups, ma.AccessGrants = K(), F(), G(), A()
model_knowledge = [{'type': 'collection', 'id': 'kb1'}, {'type': 'collection', 'id': 'kb2'}, {'type': 'file', 'id': 'fa'}]
print(asyncio.run(kb_exec('ls', __user__={'id': 'u1', 'role': 'user'}, __model_knowledge__=model_knowledge)))
