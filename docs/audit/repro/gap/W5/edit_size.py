from types import SimpleNamespace
import local_llm.routers.images as i
for cfg in ['1024x1024', '1024x', '1024 x 1024 px', '1024X1024']:
    try:
        print(repr(cfg), '->', i._edit_size(SimpleNamespace(IMAGE_EDIT_SIZE=cfg), i.EditImageForm(image='data:,', prompt='p')))
    except Exception as e:
        print(repr(cfg), '-> raised', type(e).__name__, e)
