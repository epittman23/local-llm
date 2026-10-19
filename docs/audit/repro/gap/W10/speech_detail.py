from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from local_llm.constants import ERROR_MESSAGES

print('ERROR_MESSAGES.OPENAI_NOT_FOUND is', ERROR_MESSAGES.OPENAI_NOT_FOUND)
app = FastAPI()

@app.post('/openai/audio/speech')
async def speech():
    # what routers/openai.py:612 + :671 do when no connection is https://api.openai.com/v1
    try:
        ['https://openrouter.ai/api/v1'].index('https://api.openai.com/v1')
    except ValueError:
        raise HTTPException(status_code=401, detail=ERROR_MESSAGES.OPENAI_NOT_FOUND)

r = TestClient(app, raise_server_exceptions=False).post('/openai/audio/speech')
print(r.status_code, r.text[:100])
