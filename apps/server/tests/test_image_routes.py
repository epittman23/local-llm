"""Characterization tests for image generation and editing in routers/images.py.

image_generations and image_edits were refactored for ruff's complexity
limit with no tests of their own, so these pin what they did before the
refactor: what each returns (or raises), and every request it makes to the
image engines, every image it loads, uploads and links to a chat, in order.
The HTTP sessions, URL validation, file serving, uploads, ComfyUI and the
image config are fakes that record their calls. Each case was recorded from
the untouched functions into fixtures/image_routes.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`IMAGE_ROUTES_GOLDEN_RECORD=1 pytest tests/test_image_routes.py`.
"""

import asyncio
import base64
import copy
import io
import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse

from local_llm.routers import images

GOLDEN = Path(__file__).parent / 'fixtures' / 'image_routes.json'
RECORD = os.environ.get('IMAGE_ROUTES_GOLDEN_RECORD') == '1'


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


PNG = f'data:image/png;base64,{b64("png-one")}'
JPEG = f'data:image/jpeg;base64,{b64("jpeg-one")}'
OAI_B64 = {'json': {'data': [{'b64_json': b64('out-1')}, {'b64_json': b64('out-2')}]}}
OAI_URL = {'json': {'data': [{'url': 'https://cdn.test/img1.png'}]}}
CDN_PNG = ('get', 'cdn.test', {'body': 'cdn-bytes', 'headers': {'content-type': 'image/png'}})
COMFY_PNG = {'body': 'comfy-bytes', 'headers': {'content-type': 'image/png'}}

GEN_CASES = [
    ('openai_b64', {'form': {'prompt': 'a cat', 'n': 2}}, {'routes': [('post', '/images/generations', OAI_B64)]}),
    (
        'openai_form_size_and_chat',
        {'form': {'prompt': 'p', 'size': '256x256'}, 'metadata': {'chat_id': 'c1', 'message_id': 'm1'}},
        {'routes': [('post', '/images/generations', {'json': {'data': [{'b64_json': b64('one')}]}})]},
    ),
    (
        'openai_url_model_versioned',
        {'form': {'prompt': 'p'}},
        {
            'config': {
                'IMAGE_GENERATION_MODEL': 'gpt-image-1',
                'IMAGES_OPENAI_API_VERSION': '2024-02-01',
                'IMAGES_OPENAI_API_PARAMS': {'quality': 'high'},
            },
            'forward_headers': True,
            'routes': [('post', '/images/generations', OAI_URL), CDN_PNG],
        },
    ),
    (
        'openai_no_size',
        {'form': {'prompt': 'p'}},
        {'config': {'IMAGE_SIZE': ''}, 'routes': [('post', '/gen', OAI_B64)]},
    ),
    (
        'openai_size_auto',
        {'form': {'prompt': 'p'}},
        {'config': {'IMAGE_SIZE': 'auto'}, 'routes': [('post', '/', OAI_B64)]},
    ),
    (
        'openai_model_default',
        {'form': {'prompt': 'p'}},
        {'config': {'IMAGE_GENERATION_MODEL': ''}, 'routes': [('post', '/', OAI_B64)]},
    ),
    (
        'openai_url_not_image',
        {'form': {'prompt': 'p'}},
        {
            'routes': [
                ('post', '/images/generations', OAI_URL),
                ('get', 'cdn.test', {'headers': {'content-type': 'text/html'}}),
            ]
        },
    ),
    (
        'openai_bad_base64',
        {'form': {'prompt': 'p'}},
        {'routes': [('post', '/images/generations', {'json': {'data': [{'b64_json': 'not base64!!'}]}})]},
    ),
    ('openai_http_error', {'form': {'prompt': 'p'}}, {'routes': [('post', '/images/generations', {'status': 401})]}),
    ('invalid_form_size', {'form': {'prompt': 'p', 'size': 'bigxwide'}}, {}),
    (
        'gemini_predict_default_model',
        {'form': {'prompt': 'p', 'n': 2}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'gemini', 'IMAGE_GENERATION_MODEL': ''},
            'routes': [
                (
                    'post',
                    ':predict',
                    {'json': {'predictions': [{'bytesBase64Encoded': b64('g1')}, {'bytesBase64Encoded': b64('g2')}]}},
                )
            ],
        },
    ),
    (
        'gemini_predict_explicit',
        {'form': {'prompt': 'p'}},
        {
            'config': {
                'IMAGE_GENERATION_ENGINE': 'gemini',
                'IMAGE_GENERATION_MODEL': 'imagen-4',
                'IMAGES_GEMINI_ENDPOINT_METHOD': 'predict',
            },
            'routes': [('post', ':predict', {'json': {'predictions': [{'bytesBase64Encoded': b64('g1')}]}})],
        },
    ),
    (
        'gemini_generate_content',
        {'form': {'prompt': 'p'}, 'metadata': {'chat_id': 'c1'}},
        {
            'config': {
                'IMAGE_GENERATION_ENGINE': 'gemini',
                'IMAGE_GENERATION_MODEL': 'gemini-img',
                'IMAGES_GEMINI_ENDPOINT_METHOD': 'generateContent',
            },
            'routes': [
                (
                    'post',
                    ':generateContent',
                    {
                        'json': {
                            'candidates': [
                                {'content': {'parts': [{'inlineData': {'data': b64('c1')}}, {'text': 'here you go'}]}},
                                {'content': {'parts': [{'inlineData': {}}, {'inlineData': {'data': b64('c2')}}]}},
                            ]
                        }
                    },
                )
            ],
        },
    ),
    (
        'gemini_unknown_method',
        {'form': {'prompt': 'p'}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'gemini', 'IMAGES_GEMINI_ENDPOINT_METHOD': 'stream'},
            'routes': [('post', '/models/', {'json': {}})],
        },
    ),
    (
        'gemini_http_error',
        {'form': {'prompt': 'p'}},
        {'config': {'IMAGE_GENERATION_ENGINE': 'gemini'}, 'routes': [('post', '/models/', {'status': 403})]},
    ),
    (
        'comfyui_config_steps_trusted_url',
        {'form': {'prompt': 'p', 'size': '640x480', 'negative_prompt': 'blurry', 'n': 1}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'comfyui', 'IMAGE_STEPS': 20, 'COMFYUI_API_KEY': 'ck'},
            'comfy_result': {'data': [{'url': 'http://comfy.test:8188/view?filename=a.png'}]},
            'routes': [('get', 'comfy.test', COMFY_PNG)],
        },
    ),
    (
        'comfyui_form_steps_untrusted_url',
        {'form': {'prompt': 'p', 'steps': 5}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'comfyui', 'IMAGE_GENERATION_MODEL': 'sdxl.safetensors'},
            'comfy_result': {'data': [{'url': 'http://other.test/view?filename=a.png'}]},
            'routes': [('get', 'other.test', COMFY_PNG)],
        },
    ),
    (
        'comfyui_no_steps',
        {'form': {'prompt': 'p'}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'comfyui', 'IMAGE_GENERATION_MODEL': ''},
            'comfy_result': {'data': []},
        },
    ),
    (
        'a1111_admin_sets_model',
        {'form': {'prompt': 'p', 'model': 'sdxl', 'n': 2}},
        {
            'admin': True,
            'config': {'IMAGE_GENERATION_ENGINE': 'automatic1111', 'AUTOMATIC1111_API_AUTH': 'user:pass'},
            'routes': [
                ('get', '/sdapi/v1/options', {'json': {'sd_model_checkpoint': 'sd15'}}),
                ('post', '/sdapi/v1/txt2img', {'json': {'images': [b64('a1'), b64('a2')], 'info': 'seed=1'}}),
            ],
        },
    ),
    (
        'a1111_user_model_ignored',
        {'form': {'prompt': 'p', 'model': 'sdxl', 'steps': 30, 'negative_prompt': 'ugly'}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': '', 'AUTOMATIC1111_PARAMS': {'cfg_scale': 7, 'width': 768}},
            'routes': [
                ('get', '/sdapi/v1/options', {'json': {'sd_model_checkpoint': 'sd15'}}),
                ('post', '/sdapi/v1/txt2img', {'json': {'images': [b64('a1')], 'info': 'seed=2'}}),
            ],
        },
    ),
    (
        'a1111_options_fail',
        {'form': {'prompt': 'p'}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'automatic1111'},
            'routes': [('get', '/sdapi/v1/options', {'json_raises': 'connection refused'})],
        },
    ),
    (
        'a1111_missing_images',
        {'form': {'prompt': 'p'}},
        {
            'config': {'IMAGE_GENERATION_ENGINE': 'automatic1111'},
            'routes': [
                ('get', '/sdapi/v1/options', {'json': {'sd_model_checkpoint': 'sd15'}}),
                ('post', '/sdapi/v1/txt2img', {'json': {'error': 'out of memory'}}),
            ],
        },
    ),
    ('unknown_engine', {'form': {'prompt': 'p'}}, {'config': {'IMAGE_GENERATION_ENGINE': 'dalle-mini'}}),
]

EDIT_GEMINI = {'IMAGE_EDIT_ENGINE': 'gemini', 'IMAGE_EDIT_MODEL': 'gemini-2.5-flash-image'}
EDIT_COMFY = {'IMAGE_EDIT_ENGINE': 'comfyui', 'IMAGE_EDIT_MODEL': 'qwen-edit'}
GEMINI_REPLY = {
    'json': {
        'candidates': [
            {'content': {'parts': [{'text': 'edited'}, {'inlineData': {'data': b64('e1')}}]}},
        ]
    }
}
EDIT_CASES = [
    (
        'openai_data_url_and_chat',
        {
            'form': {'image': PNG, 'prompt': 'add a hat', 'n': 2, 'background': 'transparent'},
            'metadata': {'chat_id': 'c1', 'message_id': 'm1'},
        },
        {'config': {'IMAGE_EDIT_SIZE': '1024x1024'}, 'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    (
        'openai_list_versioned',
        {'form': {'image': [PNG, JPEG], 'prompt': 'merge', 'size': '512x512'}},
        {
            'config': {'IMAGE_EDIT_MODEL': 'gpt-image-1', 'IMAGES_EDIT_OPENAI_API_VERSION': '2025-04-01'},
            'normalize': False,
            'forward_headers': True,
            'routes': [('post', '/images/edits', {'json': {'data': [{'b64_json': b64('one')}]}})],
        },
    ),
    (
        'openai_single_unnormalized',
        {'form': {'image': JPEG, 'prompt': 'p', 'background': 'opaque'}},
        {'normalize': False, 'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    (
        'openai_model_override',
        {'form': {'image': PNG, 'prompt': 'p', 'model': 'gpt-image-1'}},
        {'config': {'IMAGE_EDIT_MODEL': 'dall-e-2'}, 'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    (
        'openai_url_response',
        {'form': {'image': PNG, 'prompt': 'p'}},
        {'routes': [('post', '/images/edits', OAI_URL), CDN_PNG]},
    ),
    (
        'openai_http_error',
        {'form': {'image': PNG, 'prompt': 'p'}},
        {'routes': [('post', '/images/edits', {'status': 429})]},
    ),
    (
        'size_without_x',
        {'form': {'image': PNG, 'prompt': 'p', 'size': 'auto'}},
        {'config': {'IMAGE_EDIT_SIZE': '1024x1024'}},
    ),
    (
        'size_form_only',
        {'form': {'image': PNG, 'prompt': 'p', 'size': '300x200'}},
        {'config': {**EDIT_COMFY}, 'comfy_result': {'data': []}},
    ),
    (
        'image_http_external',
        {'form': {'image': 'https://img.test/a.jpg', 'prompt': 'p'}},
        {
            'routes': [
                ('get', 'img.test', {'body': 'remote-jpeg', 'headers': {'content-type': 'image/jpeg'}}),
                ('post', '/images/edits', OAI_B64),
            ]
        },
    ),
    ('image_http_blocked', {'form': {'image': 'https://blocked.test/a.png', 'prompt': 'p'}}, {}),
    (
        'image_http_status_error',
        {'form': {'image': 'https://img.test/gone.png', 'prompt': 'p'}},
        {'routes': [('get', 'img.test', {'status': 404})]},
    ),
    (
        'image_own_file_url',
        {'form': {'image': 'http://app.local/api/v1/files/f1/content', 'prompt': 'p'}},
        {'config': {**EDIT_GEMINI}, 'routes': [('post', ':generateContent', GEMINI_REPLY)]},
    ),
    (
        'image_own_host_other_path',
        {'form': {'image': 'http://app.local/static/a.png', 'prompt': 'p'}},
        {
            'config': {**EDIT_GEMINI},
            'routes': [
                ('get', 'app.local/static', {'body': 'static-png', 'headers': {'content-type': 'image/png'}}),
                ('post', ':generateContent', GEMINI_REPLY),
            ],
        },
    ),
    (
        'image_file_path',
        {'form': {'image': '/api/v1/files/f2/content', 'prompt': 'p'}},
        {'config': {**EDIT_GEMINI}, 'routes': [('post', ':generateContent', GEMINI_REPLY)]},
    ),
    (
        'image_file_id',
        {'form': {'image': 'f1', 'prompt': 'p'}},
        {'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    (
        'image_file_not_served',
        {'form': {'image': 'f_dict', 'prompt': 'p'}},
        {'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    ('image_file_missing', {'form': {'image': 'f_missing', 'prompt': 'p'}}, {}),
    (
        'image_list_mixed',
        {'form': {'image': [PNG, 'f2', 'http://app.local/api/v1/files/f1/content'], 'prompt': 'p'}},
        {'routes': [('post', '/images/edits', OAI_B64)]},
    ),
    (
        'gemini_single',
        {'form': {'image': PNG, 'prompt': 'p'}, 'metadata': {'chat_id': 'c1', 'message_id': 'm1'}},
        {
            'config': {**EDIT_GEMINI},
            'routes': [
                (
                    'post',
                    ':generateContent',
                    {
                        'json': {
                            'candidates': [
                                {'content': {'parts': [{'inlineData': {'data': b64('e1')}}, {'text': 'x'}]}},
                                {'content': {'parts': [{'inlineData': {'data': b64('e2')}}]}},
                            ]
                        }
                    },
                )
            ],
        },
    ),
    (
        'gemini_list_jpeg_override',
        {'form': {'image': [PNG, JPEG], 'prompt': 'p', 'model': 'g-override'}},
        {'config': {**EDIT_GEMINI}, 'routes': [('post', ':generateContent', GEMINI_REPLY)]},
    ),
    ('gemini_raw_base64', {'form': {'image': b64('raw-bytes'), 'prompt': 'p'}}, {'config': {**EDIT_GEMINI}}),
    (
        'gemini_http_error',
        {'form': {'image': PNG, 'prompt': 'p'}},
        {'config': {**EDIT_GEMINI}, 'routes': [('post', ':generateContent', {'status': 500})]},
    ),
    (
        'comfyui_single',
        {'form': {'image': PNG, 'prompt': 'p', 'n': 2}, 'metadata': {'chat_id': 'c1'}},
        {
            'config': {**EDIT_COMFY, 'IMAGE_EDIT_SIZE': '640x480', 'IMAGES_EDIT_COMFYUI_API_KEY': 'ck'},
            'comfy_upload': 'named',
            'comfy_result': {
                'data': [
                    {'url': 'http://comfy.test:8188/view?filename=o1.png&type=output'},
                    {'url': 'http://comfy.test:8188/view?filename=t1.png&type=temp'},
                ]
            },
            'routes': [('get', 'comfy.test', COMFY_PNG)],
        },
    ),
    (
        'comfyui_list_duplicate_outputs',
        {'form': {'image': [PNG, JPEG], 'prompt': 'p'}},
        {
            'config': {**EDIT_COMFY},
            'comfy_upload': 'unnamed',
            'comfy_result': {
                'data': [
                    {'url': 'http://comfy.test:8188/view?filename=o2.png&type=output'},
                    {'url': 'http://comfy.test:8188/view?filename=o1.png&type=output'},
                    {'url': 'http://comfy.test:8188/view?filename=o2.png&type=output'},
                    {'url': 'http://comfy.test:8188/view?filename=t1.png&type=temp'},
                ]
            },
            'routes': [
                ('get', 'o1.png', {'body': 'comfy-o1', 'headers': {'content-type': 'image/png'}}),
                ('get', 'o2.png', {'body': 'comfy-o2', 'headers': {'content-type': 'image/png'}}),
            ],
        },
    ),
    (
        'comfyui_no_output_urls_untrusted',
        {'form': {'image': PNG, 'prompt': 'p'}},
        {
            'config': {**EDIT_COMFY},
            'comfy_upload': 'named',
            'comfy_result': {'data': [{'url': 'http://other.test/view?filename=t1.png&type=temp'}]},
            'routes': [('get', 'other.test', COMFY_PNG)],
        },
    ),
    (
        'comfyui_upload_fails',
        {'form': {'image': PNG, 'prompt': 'p'}},
        {'config': {**EDIT_COMFY}, 'comfy_upload': 'raise'},
    ),
    ('unsupported_engine', {'form': {'image': PNG, 'prompt': 'p'}}, {'config': {'IMAGE_EDIT_ENGINE': 'automatic1111'}}),
]

CASES = [(f'gen:{c}', 'gen', k, w) for c, k, w in GEN_CASES] + [(f'edit:{c}', 'edit', k, w) for c, k, w in EDIT_CASES]

BASE_CONFIG = {
    'IMAGE_GENERATION_ENGINE': 'openai',
    'IMAGE_GENERATION_MODEL': 'dall-e-3',
    'IMAGE_SIZE': '1024x1024',
    'IMAGE_STEPS': None,
    'IMAGES_OPENAI_API_BASE_URL': 'https://oai.test/v1',
    'IMAGES_OPENAI_API_KEY': 'sk-gen',
    'IMAGES_OPENAI_API_VERSION': '',
    'IMAGES_OPENAI_API_PARAMS': None,
    'AUTOMATIC1111_BASE_URL': 'http://a1111.test',
    'AUTOMATIC1111_API_AUTH': '',
    'AUTOMATIC1111_PARAMS': None,
    'COMFYUI_BASE_URL': 'http://comfy.test:8188',
    'COMFYUI_API_KEY': '',
    'COMFYUI_WORKFLOW': '{"3": {}}',
    'COMFYUI_WORKFLOW_NODES': [],
    'IMAGES_GEMINI_API_BASE_URL': 'https://gem.test/v1beta',
    'IMAGES_GEMINI_API_KEY': 'g-key',
    'IMAGES_GEMINI_ENDPOINT_METHOD': '',
    'IMAGE_EDIT_ENGINE': 'openai',
    'IMAGE_EDIT_MODEL': 'dall-e-2',
    'IMAGE_EDIT_SIZE': '',
    'IMAGES_EDIT_OPENAI_API_BASE_URL': 'https://oai.test/v1',
    'IMAGES_EDIT_OPENAI_API_KEY': 'sk-edit',
    'IMAGES_EDIT_OPENAI_API_VERSION': '',
    'IMAGES_EDIT_GEMINI_API_BASE_URL': 'https://gem.test/v1beta',
    'IMAGES_EDIT_GEMINI_API_KEY': 'ge-key',
    'IMAGES_EDIT_COMFYUI_BASE_URL': 'http://comfy.test:8188',
    'IMAGES_EDIT_COMFYUI_API_KEY': '',
    'IMAGES_EDIT_COMFYUI_WORKFLOW': '{"9": {}}',
    'IMAGES_EDIT_COMFYUI_WORKFLOW_NODES': [],
}

# Files the fake file route serves: a FileResponse on disk, something else, or a 404.
SERVED_FILES = {'f1': ('f1.png', 'file-one'), 'f2': ('f2.jpg', 'file-two')}


def _plain(value):
    """Turn what the code passed to a fake into JSON-comparable data."""
    if isinstance(value, bytes):
        return {'bytes': value.decode('latin-1')}
    if isinstance(value, io.BytesIO):
        return {'bytes': value.getvalue().decode('latin-1')}
    if isinstance(value, _FormData):
        return {'form': value.fields}
    if hasattr(value, 'model_dump'):
        return _plain(value.model_dump())
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


class _FormData:
    def __init__(self):
        self.fields = []

    def add_field(self, name, value, filename=None, content_type=None):
        self.fields.append([name, _plain(value), filename, content_type])


class _Response:
    def __init__(self, spec):
        self.spec = spec
        self.status = spec.get('status', 200)
        self.headers = spec.get('headers', {})

    def raise_for_status(self):
        if self.status >= 400:
            raise aiohttp.ClientResponseError(
                SimpleNamespace(real_url='fake'), (), status=self.status, message=f'HTTP {self.status}'
            )

    async def json(self, content_type=None):
        if 'json_raises' in self.spec:
            raise RuntimeError(self.spec['json_raises'])
        return copy.deepcopy(self.spec.get('json'))

    async def read(self):
        return self.spec.get('body', '').encode()


class _Session:
    def __init__(self, kind, routes, log):
        self.kind, self.routes, self.log = kind, routes, log

    @asynccontextmanager
    async def _call(self, method, url, kwargs):
        ssl = kwargs.pop('ssl', None) is images.AIOHTTP_CLIENT_SESSION_SSL
        self.log.append([self.kind, method, url, _plain(kwargs), {'ssl': ssl}])
        for route_method, fragment, spec in self.routes:
            if route_method == method and fragment in url:
                yield _Response(spec)
                return
        raise AssertionError(f'unrouted {method} {url}')

    def get(self, url, **kwargs):
        return self._call('get', url, kwargs)

    def post(self, url=None, **kwargs):
        return self._call('post', url, kwargs)


def _install_network(m, world, log):
    routes = world.get('routes', [])

    async def get_session():
        return _Session('session', routes, log)

    @asynccontextmanager
    async def get_ssrf_safe_session():
        yield _Session('ssrf_session', routes, log)

    def validate_url(url):
        log.append(['validate_url', url])
        if 'blocked' in url:
            raise ValueError('URL blocked: private address')
        return True

    m.setattr(images, 'get_session', get_session)
    m.setattr(images, 'get_ssrf_safe_session', get_ssrf_safe_session)
    m.setattr(images, 'validate_url', validate_url)


def _install_files(m, log, file_dir):
    async def get_file_content_by_id(file_id, user, attachment=False, db=None):
        log.append(['serve_file', file_id, user.id, attachment, db])
        if file_id in SERVED_FILES:
            name, content = SERVED_FILES[file_id]
            path = Path(file_dir) / name
            path.write_text(content)
            return FileResponse(str(path))
        if file_id == 'f_dict':
            return {'detail': 'stored remotely'}
        raise HTTPException(status_code=404, detail='File not found')

    async def upload_file_handler(request, file, metadata, process, user):
        content = file.file.getvalue().decode('latin-1')
        log.append(
            ['upload', file.filename, content, file.headers.get('content-type'), _plain(metadata), process, user.id]
        )
        return SimpleNamespace(
            id=f'file:{content}', filename=file.filename, meta={'name': f'{content}.out', 'content_type': 'image/out'}
        )

    async def insert_chat_files(chat_id, message_id, file_ids, user_id, db=None):
        log.append(['link_chat_files', chat_id, message_id, file_ids, user_id, db])

    m.setattr(images, 'get_file_content_by_id', get_file_content_by_id)
    m.setattr(images, 'upload_file_handler', upload_file_handler)
    m.setattr(images.Chats, 'insert_chat_files', insert_chat_files)


def _install_comfyui(m, world, log):
    async def comfyui_upload_image(file_item, base_url, api_key):
        param, (filename, file_obj, mime) = file_item
        log.append(['comfyui_upload', param, filename, _plain(file_obj), mime, base_url, api_key])
        if world.get('comfy_upload') == 'raise':
            raise RuntimeError('comfyui unreachable')
        return {'name': f'uploaded-{filename}'} if world.get('comfy_upload') == 'named' else {}

    def comfyui_run(kind):
        async def run(model, form, client_id, base_url, api_key):
            log.append([kind, model, _plain(form), client_id, base_url, api_key])
            return copy.deepcopy(world.get('comfy_result'))

        return run

    m.setattr(images, 'comfyui_upload_image', comfyui_upload_image)
    m.setattr(images, 'comfyui_create_image', comfyui_run('comfyui_create'))
    m.setattr(images, 'comfyui_edit_image', comfyui_run('comfyui_edit'))


def _install_world(m, world, log, file_dir):
    config = {**BASE_CONFIG, **copy.deepcopy(world.get('config', {}))}

    async def get_image_config():
        return SimpleNamespace(**copy.deepcopy(config))

    async def set_image_model(request, model):
        log.append(['set_image_model', model])

    def normalize(data_url):
        log.append(['normalize', data_url])
        return data_url

    def include_user_info_headers(headers, user):
        return {**headers, 'X-User-Id': user.id}

    uuids = iter(f'uuid-{n}' for n in range(1, 100))
    m.setattr(images.uuid, 'uuid4', lambda: next(uuids))
    m.setattr(images, 'get_image_config', get_image_config)
    m.setattr(images, 'set_image_model', set_image_model)
    m.setattr(images, 'normalize_openai_edit_image_data_url', normalize)
    m.setattr(images, 'include_user_info_headers', include_user_info_headers)
    m.setattr(images, 'ENABLE_FORWARD_USER_INFO_HEADERS', world.get('forward_headers', False))
    m.setattr(images, 'ENABLE_OPENAI_IMAGE_EDIT_NORMALIZATION', world.get('normalize', True))
    m.setattr(images, 'IMAGE_URL_RESPONSE_MODELS_REGEX_PATTERN', '^gpt-image')
    m.setattr(images.aiohttp, 'FormData', _FormData)
    _install_network(m, world, log)
    _install_files(m, log, file_dir)
    _install_comfyui(m, world, log)


def _call(tool, kwargs, user):
    request = SimpleNamespace(
        base_url='http://app.local/',
        app=SimpleNamespace(url_path_for=lambda name, id: f'/api/v1/files/{id}/content'),
    )
    form_class, function = (
        (images.CreateImageForm, images.image_generations)
        if tool == 'gen'
        else (images.EditImageForm, images.image_edits)
    )
    form = form_class(**copy.deepcopy(kwargs['form']))
    return function(request, form, metadata=copy.deepcopy(kwargs.get('metadata')), user=user)


def _run(tool, kwargs, world, monkeypatch):
    log = []
    user = SimpleNamespace(id='u1', role='admin' if world.get('admin') else 'user', name='Ada', email='ada@example.com')
    with tempfile.TemporaryDirectory() as file_dir:
        _install_world(monkeypatch, world, log, file_dir)
        try:
            outcome = {'returned': asyncio.run(_call(tool, kwargs, user))}
        except HTTPException as e:
            outcome = {'http_error': [e.status_code, str(e.detail)]}
        except Exception as e:
            outcome = {'raised': [type(e).__name__, str(e)]}
    return json.loads(json.dumps({**outcome, 'calls': log}))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'tool', 'kwargs', 'world'), CASES, ids=[c[0] for c in CASES])
def test_image_route_matches_golden(monkeypatch, case_id, tool, kwargs, world):
    observed = _run(tool, kwargs, world, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when IMAGE_ROUTES_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set IMAGE_ROUTES_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, tool, kwargs, world in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(tool, kwargs, world, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
