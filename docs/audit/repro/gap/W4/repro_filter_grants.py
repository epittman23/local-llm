"""Repro: a co-editor's ordinary save strips grants it did not add.

filter_allowed_access_grants is applied to the full, round-tripped grant list
that the workspace editors send back on every save (models.py:824,
prompts.py:290, skills.py:310). With the default user permissions
(sharing.public_* = False), an existing admin-set public grant is removed.
"""
import asyncio

import local_llm.utils.access_control as ac


async def fake_has_permission(user_id, key, default_permissions, db=None):
    # Defaults from config.py: sharing.public_models/prompts/skills False,
    # access_grants.allow_users / allow_groups True.
    return {
        'sharing.public_models': False,
        'sharing.public_prompts': False,
        'sharing.public_skills': False,
        'access_grants.allow_users': True,
        'access_grants.allow_groups': True,
    }.get(key, False)


ac.has_permission = fake_has_permission

# What GET /api/v1/models/model?id=... returned to the editor (admin made it public,
# and gave bob write access), and what ModelEditor's buildModelInfo sends back unchanged.
existing = [
    {'id': 'g1', 'principal_type': 'user', 'principal_id': '*', 'permission': 'read'},
    {'id': 'g2', 'principal_type': 'user', 'principal_id': 'bob', 'permission': 'write'},
]


async def main():
    for key in ('sharing.public_models', 'sharing.public_prompts', 'sharing.public_skills'):
        out = await ac.filter_allowed_access_grants({}, 'bob', 'user', list(existing), key)
        print(key, '->', [(g['principal_id'], g['permission']) for g in out])


asyncio.run(main())
