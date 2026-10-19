"""STT engine 'Web API' (value 'web', offered in Admin > Audio): transcribe() on an uploaded audio file."""
import asyncio, os, subprocess, tempfile
from types import SimpleNamespace
import local_llm.routers.audio as a
from local_llm.models.config import Config

async def main():
    await Config.upsert({'audio.stt.engine': 'web'})
    d = tempfile.mkdtemp(); p = os.path.join(d, 'id_clip.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', p], check=True)
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(faster_whisper_model=None)))
    print('handler returns:', await a.transcription_handler(req, p, None))
    try:
        print(await a.transcribe(req, p, None, None))
    except Exception as e:
        print('transcribe raised:', type(e).__name__, e)

asyncio.run(main())
