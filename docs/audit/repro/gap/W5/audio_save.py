import asyncio
from types import SimpleNamespace
import local_llm.routers.audio as a
from local_llm.models.config import Config

async def main():
    tts = dict(OPENAI_API_BASE_URL='', OPENAI_API_KEY='', OPENAI_PARAMS=None, API_KEY='', ENGINE='openai', MODEL='tts-1',
               VOICE='nova-CHANGED', SPLIT_ON='punctuation', AZURE_SPEECH_REGION='', AZURE_SPEECH_BASE_URL='',
               AZURE_SPEECH_OUTPUT_FORMAT='', MISTRAL_API_KEY='', MISTRAL_API_BASE_URL='')
    stt = dict(OPENAI_API_BASE_URL='', OPENAI_API_KEY='', ENGINE='', MODEL='', WHISPER_MODEL='base', DEEPGRAM_API_KEY='',
               AZURE_API_KEY='', AZURE_REGION='', AZURE_LOCALES='', AZURE_BASE_URL='', AZURE_MAX_SPEAKERS='',
               MISTRAL_API_KEY='', MISTRAL_API_BASE_URL='', MISTRAL_USE_CHAT_COMPLETIONS=False)
    form = a.AudioConfigUpdateForm(tts=tts, stt=stt)
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(faster_whisper_model=None)))
    print('voice before:', await Config.get('audio.tts.voice'))
    try:
        await a.update_audio_config(req, form, SimpleNamespace(id='u1', role='admin'))
        print('save returned OK')
    except Exception as e:
        print('save RAISED (-> HTTP 500):', type(e).__name__, str(e)[:120])
    print('voice after (persisted anyway):', await Config.get('audio.tts.voice'))

asyncio.run(main())
