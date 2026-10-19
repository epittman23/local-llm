from pydantic import ValidationError
from local_llm.routers.images import ImagesConfig
from local_llm.routers.retrieval import ConfigForm

base = dict(ENABLE_IMAGE_GENERATION=True, ENABLE_IMAGE_PROMPT_GENERATION=True, IMAGE_GENERATION_ENGINE='automatic1111',
  IMAGE_GENERATION_MODEL='', IMAGE_SIZE='512x512', IMAGE_STEPS=50, IMAGES_OPENAI_API_BASE_URL='', IMAGES_OPENAI_API_KEY='',
  IMAGES_OPENAI_API_VERSION='', IMAGES_OPENAI_API_PARAMS={}, AUTOMATIC1111_BASE_URL='', AUTOMATIC1111_API_AUTH='',
  AUTOMATIC1111_PARAMS={}, COMFYUI_BASE_URL='', COMFYUI_API_KEY='', COMFYUI_WORKFLOW='', COMFYUI_WORKFLOW_NODES=[],
  IMAGES_GEMINI_API_BASE_URL='', IMAGES_GEMINI_API_KEY='', IMAGES_GEMINI_ENDPOINT_METHOD='', ENABLE_IMAGE_EDIT=False,
  IMAGE_EDIT_ENGINE='openai', IMAGE_EDIT_MODEL='', IMAGE_EDIT_SIZE='', IMAGES_EDIT_OPENAI_API_BASE_URL='',
  IMAGES_EDIT_OPENAI_API_KEY='', IMAGES_EDIT_OPENAI_API_VERSION='', IMAGES_EDIT_GEMINI_API_BASE_URL='',
  IMAGES_EDIT_GEMINI_API_KEY='', IMAGES_EDIT_COMFYUI_BASE_URL='', IMAGES_EDIT_COMFYUI_API_KEY='',
  IMAGES_EDIT_COMFYUI_WORKFLOW='', IMAGES_EDIT_COMFYUI_WORKFLOW_NODES=[])
for steps in ['', None]:
    try:
        f = ImagesConfig(**{**base, 'IMAGE_STEPS': steps})
        print('IMAGE_STEPS', repr(steps), '-> accepted', f.IMAGE_STEPS)
        try:
            f.IMAGE_STEPS < 0
        except TypeError as e:
            print('  then update_config `IMAGE_STEPS < 0` raises TypeError:', e)
    except ValidationError as e:
        print('IMAGE_STEPS', repr(steps), '-> 422:', e.errors()[0]['msg'])

for v in [[], 1]:
    try:
        ConfigForm(DOCLING_PARAMS=v); print('DOCLING_PARAMS', v, 'accepted')
    except ValidationError as e:
        print('DOCLING_PARAMS', repr(v), '-> 422:', e.errors()[0]['msg'])
f = ConfigForm(HYBRID_BM25_WEIGHT=None)
print('HYBRID_BM25_WEIGHT null parsed as', f.HYBRID_BM25_WEIGHT, '(update_rag_config keeps the stored value when None)')
