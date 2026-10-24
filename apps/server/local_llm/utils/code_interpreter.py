import asyncio
import base64
import logging
import os
import time
import uuid

import aiohttp
import websockets
from pydantic import BaseModel

from local_llm.env import AIOHTTP_CLIENT_ALLOW_REDIRECTS
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.upstream_trace import note_code_run

logger = logging.getLogger(__name__)

#: Where each run works on the Jupyter server, relative to its root: a
#: subdirectory per run, holding the chat's files, removed when the run ends.
UPLOADS_DIR = 'lllm-uploads'
#: Copied files are sent base64-encoded in one request each, so they are capped.
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024


async def chat_files(items: list | None, user) -> tuple[list[tuple[str, str]], list[str]]:
    """The chat's uploaded files this user may read, as (name, local path) pairs.

    `items` is the chat's `metadata['files']`. Only uploaded files count
    (type 'file' with an id): knowledge bases, web results and images are not
    files on disk. Each one is re-checked against the user, since the list
    comes from the request. Also returns a note for each file left out.
    """
    from local_llm.models.files import Files
    from local_llm.storage.provider import Storage
    from local_llm.utils.access_control.files import has_access_to_file

    files: list[tuple[str, str]] = []
    notes: list[str] = []
    names: set[str] = set()
    total = 0
    for item in items or []:
        if not isinstance(item, dict) or item.get('type') != 'file' or not item.get('id'):
            continue
        file = await Files.get_file_by_id(item['id'])
        if not file or not file.path or user is None:
            continue
        if file.user_id != user.id and not await has_access_to_file(file.id, 'read', user):
            continue
        name = os.path.basename((file.filename or item.get('name') or file.id).replace('\\', '/')) or file.id
        try:
            path = await asyncio.to_thread(Storage.get_file, file.path)
            size = await asyncio.to_thread(os.path.getsize, path)
        except Exception as err:
            logger.warning('chat file %s is not readable: %s', file.id, err)
            notes.append(f'{name}: could not be read')
            continue
        if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
            notes.append(
                f'{name}: not copied, over the {MAX_FILE_BYTES // 2**20} MB per file'
                f' or {MAX_TOTAL_BYTES // 2**20} MB total limit'
            )
            continue
        stem, ext = os.path.splitext(name)
        n = 1
        while name in names:
            n += 1
            name = f'{stem} ({n}){ext}'
        names.add(name)
        total += size
        files.append((name, path))
    return files, notes


class ResultModel(BaseModel):
    """
    Execute Code Result Model
    """

    stdout: str | None = ''
    stderr: str | None = ''
    result: str | None = ''


class JupyterCodeExecuter:
    """
    Execute code in jupyter notebook
    """

    def __init__(
        self,
        base_url: str,
        code: str,
        token: str = '',
        password: str = '',
        timeout: int = 60,
        files: list[tuple[str, str]] | None = None,
    ):
        """
        :param base_url: Jupyter server URL (e.g., "http://localhost:8888")
        :param code: Code to execute
        :param token: Jupyter authentication token (optional)
        :param password: Jupyter password (optional)
        :param timeout: WebSocket timeout in seconds (default: 60s)
        :param files: (name, local path) pairs copied into the kernel's working directory
        """
        self.base_url = base_url
        self.code = code
        self.token = token
        self.password = password
        self.timeout = timeout
        self.kernel_id = ''
        self.files = files or []
        self.work_dir = ''
        self.failure = ''
        if self.base_url[-1] != '/':
            self.base_url += '/'
        self.session = aiohttp.ClientSession(trust_env=True, base_url=self.base_url)
        self.params = {}
        self.result = ResultModel()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.kernel_id:
            try:
                async with self.session.delete(f'api/kernels/{self.kernel_id}', params=self.params) as response:
                    response.raise_for_status()
            except Exception as err:
                logger.exception('close kernel failed, %s', err)
        if self.work_dir:
            # The server must allow deleting a non-empty directory
            # (FileContentsManager.always_delete_dir, set in infra/docker-compose.yml),
            # since the code may have written files of its own beside the copies.
            try:
                async with self.session.delete(f'api/contents/{self.work_dir}', params=self.params) as response:
                    response.raise_for_status()
            except Exception as err:
                logger.warning('removing %s from the Jupyter server failed: %s', self.work_dir, err)
        await self.session.close()

    async def run(self) -> ResultModel:
        try:
            await self.sign_in()
            await self.upload_files()
            await self.init_kernel()
            await self.execute_code()
        except Exception as err:
            logger.exception('execute code failed, %s', err)
            self.result.stderr = f'Error: {err}'
            # The interpreter failed, not the code: kept apart for a caller
            # that must not grade an answer the model gave without its code.
            self.failure = str(err)
        return self.result

    async def sign_in(self) -> None:
        # password authentication
        if self.password and not self.token:
            async with self.session.get('login') as response:
                response.raise_for_status()
                xsrf_token = response.cookies['_xsrf'].value
                if not xsrf_token:
                    raise ValueError('_xsrf token not found')
                self.session.cookie_jar.update_cookies(response.cookies)
                self.session.headers.update({'X-XSRFToken': xsrf_token})
            async with self.session.post(
                'login',
                data={'_xsrf': xsrf_token, 'password': self.password},
                allow_redirects=AIOHTTP_CLIENT_ALLOW_REDIRECTS,
            ) as response:
                response.raise_for_status()
                self.session.cookie_jar.update_cookies(response.cookies)

        # token authentication
        if self.token:
            self.params.update({'token': self.token})

    async def upload_files(self) -> None:
        """Make a fresh directory for this run, with the files copied in; it is the kernel's working directory.

        Made even when there are no files, so whatever the code writes is
        deleted with it instead of staying on the server for the next run.
        """
        work_dir = f'{UPLOADS_DIR}/{uuid.uuid4().hex}'
        for directory in (UPLOADS_DIR, work_dir):
            async with self.session.put(
                f'api/contents/{directory}', params=self.params, json={'type': 'directory'}
            ) as response:
                response.raise_for_status()
        self.work_dir = work_dir
        for name, path in self.files:
            content = base64.b64encode(await asyncio.to_thread(_read_bytes, path)).decode()
            async with self.session.put(
                f'api/contents/{work_dir}/{name}',
                params=self.params,
                json={'type': 'file', 'format': 'base64', 'content': content},
            ) as response:
                response.raise_for_status()

    async def init_kernel(self) -> None:
        async with self.session.post(url='api/kernels', params=self.params, json={'path': self.work_dir}) as response:
            response.raise_for_status()
            kernel_data = await response.json()
            self.kernel_id = kernel_data['id']

    def init_ws(self) -> (str, dict):
        ws_base = self.base_url.replace('http', 'ws', 1)
        ws_params = '?' + '&'.join([f'{key}={val}' for key, val in self.params.items()])
        websocket_url = f'{ws_base}api/kernels/{self.kernel_id}/channels{ws_params if len(ws_params) > 1 else ""}'
        ws_headers = {}
        if self.password and not self.token:
            ws_headers = {
                'Cookie': '; '.join([f'{cookie.key}={cookie.value}' for cookie in self.session.cookie_jar]),
                **self.session.headers,
            }
        return websocket_url, ws_headers

    async def execute_code(self) -> None:
        # initialize ws
        websocket_url, ws_headers = self.init_ws()
        # execute
        async with websockets.connect(websocket_url, additional_headers=ws_headers) as ws:
            await self.execute_in_jupyter(ws)

    async def execute_in_jupyter(self, ws) -> None:
        # send message
        msg_id = uuid.uuid4().hex
        await ws.send(
            JSONCodec.dumps(
                {
                    'header': {
                        'msg_id': msg_id,
                        'msg_type': 'execute_request',
                        'username': 'user',
                        'session': uuid.uuid4().hex,
                        'date': '',
                        'version': '5.3',
                    },
                    'parent_header': {},
                    'metadata': {},
                    'content': {
                        'code': self.code,
                        'silent': False,
                        'store_history': True,
                        'user_expressions': {},
                        'allow_stdin': False,
                        'stop_on_error': True,
                    },
                    'channel': 'shell',
                }
            )
        )
        # parse message
        stdout, stderr, result = '', '', []
        while True:
            try:
                # wait for message
                message = await asyncio.wait_for(ws.recv(), self.timeout)
                message_data = JSONCodec.loads(message)
                # msg id not match, skip
                if message_data.get('parent_header', {}).get('msg_id') != msg_id:
                    continue
                # check message type
                msg_type = message_data.get('msg_type')
                match msg_type:
                    case 'stream':
                        if message_data['content']['name'] == 'stdout':
                            stdout += message_data['content']['text']
                        elif message_data['content']['name'] == 'stderr':
                            stderr += message_data['content']['text']
                    case 'execute_result' | 'display_data':
                        data = message_data['content']['data']
                        if 'image/png' in data:
                            result.append(f'data:image/png;base64,{data["image/png"]}')
                        elif 'text/plain' in data:
                            result.append(data['text/plain'])
                    case 'error':
                        stderr += '\n'.join(message_data['content']['traceback'])
                    case 'status':
                        if message_data['content']['execution_state'] == 'idle':
                            break

            except TimeoutError:
                stderr += '\nExecution timed out.'
                break
        self.result.stdout = stdout.strip()
        self.result.stderr = stderr.strip()
        self.result.result = '\n'.join(result).strip() if result else ''


def _read_bytes(path: str) -> bytes:
    with open(path, 'rb') as f:
        return f.read()


async def execute_code_jupyter(
    base_url: str,
    code: str,
    token: str = '',
    password: str = '',
    idle_timeout: int = 60,
    files: list[tuple[str, str]] | None = None,
    notes: list[str] | None = None,
) -> dict:
    """Run code on a Jupyter server; idle_timeout is the longest wait for any one kernel message.

    Not a deadline for the run: code that keeps producing output runs until
    it finishes. A silence longer than idle_timeout ends the run with
    "Execution timed out." in stderr.

    `files` (from chat_files) are copied into the kernel's working directory
    first, so the code opens them by name; `notes` say which were left out,
    and are added to stderr so the model sees why a file is missing.
    """
    started = time.monotonic()
    async with JupyterCodeExecuter(base_url, code, token, password, idle_timeout, files) as executor:
        result = await executor.run()
    # A no-op unless the benchmark harness is tracing this call.
    note_code_run((time.monotonic() - started) * 1000, executor.failure)
    if notes:
        result.stderr = '\n'.join(filter(None, [result.stderr, *notes]))
    return result.model_dump()
