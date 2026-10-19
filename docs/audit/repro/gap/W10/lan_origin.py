import os, types
from fastapi.testclient import TestClient
from local_llm.socket import main as sock  # builds the real sio/app with CORS_ALLOW_ORIGIN from env
print('SOCKETIO_CORS_ORIGINS =', sock.SOCKETIO_CORS_ORIGINS)
client = TestClient(sock.app, raise_server_exceptions=False)
for origin in ['http://localhost:4000', 'http://192.168.1.20:4000']:
    r = client.get('/ws/socket.io/?EIO=4&transport=polling', headers={'Origin': origin, 'Host': origin.split('//')[1]})
    print(origin, '->', r.status_code, r.text[:60])
