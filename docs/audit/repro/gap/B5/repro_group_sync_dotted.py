"""Repro: a dotted (Auth0-style URL) groups claim name never resolves."""
import asyncio
from types import SimpleNamespace
import local_llm.utils.oauth as o

calls = []

class FakeGroups:
    def __init__(self):
        self.groups = [SimpleNamespace(id='g1', name='finance', description='', permissions={'x': 1}),
                       SimpleNamespace(id='g2', name='eng', description='', permissions={'x': 1})]
        self.members = {'g1': {'u1'}, 'g2': {'u1'}}
    async def get_groups_by_member_id(self, uid, db=None):
        return [g for g in self.groups if uid in self.members[g.id]]
    async def get_all_groups(self, db=None):
        return list(self.groups)
    async def remove_users_from_group(self, gid, uids, db=None):
        calls.append(('remove', gid)); self.members[gid] -= set(uids); return True
    async def add_users_to_group(self, gid, uids, db=None):
        calls.append(('add', gid)); self.members[gid] |= set(uids); return True
    async def update_group_by_id(self, **kw):
        return None

async def no_event(*a, **k):
    return None

async def cfg():
    return SimpleNamespace(OAUTH_GROUPS_CLAIM='groups', OAUTH_BLOCKED_GROUPS='[]', ENABLE_OAUTH_GROUP_CREATION=False,
                           OAUTH_GROUP_DEFAULT_SHARE=True)

o.Groups = FakeGroups()
o.publish_event = no_event
o.get_oauth_runtime_config = cfg
mgr = o.OAuthManager.__new__(o.OAuthManager)
user = SimpleNamespace(id='u1')

async def run(claims, label):
    calls.clear()
    await mgr.update_user_groups(None, user, claims, {})
    print(f'{label:45s} calls={calls} memberships={sorted(g for g, m in o.Groups.members.items() if "u1" in m)}')


# --- dotted (Auth0-style namespaced) claim name: roles has a flat fallback, groups does not
async def cfg_dotted():
    return SimpleNamespace(OAUTH_GROUPS_CLAIM='https://ex.com/groups', OAUTH_BLOCKED_GROUPS='[]',
                           ENABLE_OAUTH_GROUP_CREATION=False, OAUTH_GROUP_DEFAULT_SHARE=True)
o.get_oauth_runtime_config = cfg_dotted
o.Groups = FakeGroups()  # u1 in finance + eng
asyncio.run(run({'https://ex.com/groups': ['eng']}, 'dotted claim name, IdP says [eng]'))
