import os, types
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from local_llm import config  # seeds STATIC_DIR from the frontend static dir
from local_llm.env import STATIC_DIR as ENV_STATIC_DIR
print('config.STATIC_DIR =', config.STATIC_DIR)
print('env.STATIC_DIR    =', ENV_STATIC_DIR)
print('seeded files:', sorted(p.name for p in config.STATIC_DIR.iterdir()))
print('user.png exists in STATIC_DIR:', (config.STATIC_DIR / 'user.png').exists())

from local_llm.routers import users as users_router

fake_user = types.SimpleNamespace(id='u1', profile_image_url='/user.png')
app = FastAPI()

@app.get('/img')
async def img():
    with patch.object(users_router.Users, 'get_user_by_id', AsyncMock(return_value=fake_user)):
        return await users_router.get_user_profile_image_by_id('u1', user=fake_user)

client = TestClient(app, raise_server_exceptions=False)
r = client.get('/img')
print('GET profile image for a default user ->', r.status_code, r.text[:80])
