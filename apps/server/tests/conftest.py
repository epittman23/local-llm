"""Settings every test run needs before local_llm is imported.

local_llm.env creates DATA_DIR on import, so without this a test run would
create (or write into) apps/server/data, the directory `make backend` uses.
"""

import atexit
import os
import shutil
import tempfile

os.environ['DATA_DIR'] = tempfile.mkdtemp(prefix='lllm-test-data-')
atexit.register(shutil.rmtree, os.environ['DATA_DIR'], ignore_errors=True)
