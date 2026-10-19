import asyncio
from local_llm.internal.db import Base, engine
import importlib, pkgutil, local_llm.models as M
for m in pkgutil.iter_modules(M.__path__):
    importlib.import_module("local_llm.models."+m.name)
Base.metadata.create_all(engine)
import local_llm.routers.channels as rc
print('ok', rc.send_notification)
