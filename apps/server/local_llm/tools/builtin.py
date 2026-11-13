"""
Built-in tools for Local LLM.

These tools are automatically available when native function calling is enabled.

IMPORTANT: DO NOT IMPORT THIS MODULE DIRECTLY IN OTHER PARTS OF THE CODEBASE.
"""

import asyncio
import datetime as dt
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Literal, cast, get_args

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from local_llm.config import RAG_EMBEDDING_QUERY_PREFIX
from local_llm.env import (
    KNOWLEDGE_GREP_MAX_MATCHES,
    VIEW_FILE_DEFAULT_MAX_CHARS,
    VIEW_FILE_MAX_CHARS,
)
from local_llm.events import EVENTS, publish_event
from local_llm.models.channels import Channels
from local_llm.models.chats import Chats, chat_search_content_query, chat_search_terms
from local_llm.models.config import Config
from local_llm.models.groups import Groups
from local_llm.models.memories import Memories
from local_llm.models.messages import Messages
from local_llm.models.notes import Notes
from local_llm.models.users import UserModel
from local_llm.retrieval.utils import get_content_from_url
from local_llm.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT
from local_llm.routers.images import (
    CreateImageForm,
    EditImageForm,
    image_edits,
    image_generations,
)
from local_llm.routers.memories import (
    AddMemoryForm,
    ListMemoryPathsForm,
    MemoryUpdateModel,
    ReadMemoryPathForm,
    SearchMemoriesForm,
    UpdateMemoriesForm,
    update_memory_by_id,
)
from local_llm.routers.memories import (
    add_memory as _add_memory,
)
from local_llm.routers.memories import (
    list_memory_paths as _list_memory_paths,
)
from local_llm.routers.memories import (
    read_memory_path as _read_memory_path,
)
from local_llm.routers.memories import (
    search_memories as _search_memories,
)
from local_llm.routers.memories import (
    update_memories as _update_memories,
)
from local_llm.routers.retrieval import search_web as _search_web
from local_llm.sandbox import (
    ExecResult,
    ImageKey,
    SandboxError,
    SandboxNotRunning,
    SandboxRefused,
    SandboxSession,
    SandboxUnavailable,
    clamp_timeout,
    wrap_command,
)
from local_llm.sandbox import outputs as sandbox_outputs
from local_llm.sandbox import runs as sandbox_runs
from local_llm.sandbox import workspace as sandbox_files
from local_llm.sandbox.limits import OUTPUT_CHAT_CAP_BYTES, TIMEOUT_DEFAULT_S
from local_llm.sandbox.manager import TIMEOUT_KEY, OutputsMemory, SandboxManager, sandbox_setting_error
from local_llm.sandbox.telemetry import Context as PackageContext
from local_llm.sandbox.telemetry import PackageTelemetry, Pending
from local_llm.sandbox.uploads import chat_owner, sync_uploads
from local_llm.sandbox.workspace import WorkspaceError
from local_llm.socket.main import sio
from local_llm.tasks import stop_item_tasks
from local_llm.tools.knowledge_fs import kb_exec, split_lines  # noqa: F401 — re-exported
from local_llm.utils.access_control.files import is_folder_entry
from local_llm.utils.chat_id import is_saved_chat_id
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.misc import find_in_lowered
from local_llm.utils.notifications import notify_target
from local_llm.utils.sanitize import sanitize_code
from local_llm.utils.upstream_trace import note_code_run

log = logging.getLogger(__name__)

MAX_KNOWLEDGE_BASE_SEARCH_ITEMS = 10_000


async def _has_write_access_to_note(note, user_id: str) -> bool:
    if note.user_id == user_id:
        return True

    from local_llm.models.access_grants import AccessGrants

    user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]
    return await AccessGrants.has_access(
        user_id=user_id,
        resource_type='note',
        resource_id=note.id,
        permission='write',
        user_group_ids=set(user_group_ids),
    )


async def _emit_note_updated(request: Request, user: dict, note) -> None:
    await sio.emit('events:note', note.model_dump(), to=f'note:{note.id}')
    await publish_event(
        request,
        EVENTS.NOTE_UPDATED,
        actor=user,
        subject_id=note.id,
        data={'title': note.title},
    )


async def _has_read_access_to_file(
    file,
    user: dict,
    model_knowledge: list[dict] | None = None,
) -> bool:
    """Check if a user can read a file via ownership, admin role, model attachment, or access grants."""
    user_id = user.get('id')
    user_role = user.get('role', 'user')
    if file.user_id == user_id or user_role == 'admin':
        return True
    if model_knowledge and any(item.get('type') == 'file' and item.get('id') == file.id for item in model_knowledge):
        return True
    from local_llm.utils.access_control.files import has_access_to_file

    if await has_access_to_file(
        file_id=file.id,
        access_type='read',
        user=UserModel(**user),
    ):
        return True
    if not model_knowledge:
        return False
    # A file in a knowledge base from the chat's folder is readable through it (#755).
    from local_llm.models.knowledge import Knowledges

    return any(
        is_folder_entry(model_knowledge, 'collection', knowledge.id)
        for knowledge in await Knowledges.get_knowledges_by_file_id(file.id)
    )


# =============================================================================
# TIME UTILITIES
# =============================================================================


async def notify(
    message: str,
    target: str = '',
    title: str = '',
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Send a notification to the user's configured notification target.

    :param message: Notification body.
    :param target: Optional target id or name. Empty uses the default target.
    :param title: Optional notification title.
    """
    user_id = (__user__ or {}).get('id')
    if not user_id:
        return 'Notification failed: user not found.'

    app_name = getattr(getattr(__request__, 'app', None), 'state', None)
    app_name = getattr(app_name, 'LLLM_NAME', 'Local LLM')
    try:
        result = await notify_target(user_id, message, target=target, title=title, app_name=app_name)
        return f'Notification sent to {result.get("target_id")}.'
    except Exception as e:
        return f'Notification failed: {e}'


async def get_current_timestamp(
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Get the current Unix timestamp in seconds.

    :return: JSON with current_timestamp (seconds), current_iso (UTC ISO format), and user_local_iso (user's local time)
    """
    try:
        from zoneinfo import ZoneInfo

        now = dt.datetime.now(dt.UTC)
        result = {
            'current_timestamp': int(now.timestamp()),
            'current_iso': now.isoformat(),
        }

        # Include the user's local time if timezone is available
        tz_name = __user__.get('timezone') if __user__ else None
        if tz_name:
            try:
                user_tz = ZoneInfo(tz_name)
                user_now = now.astimezone(user_tz)
                result['user_local_iso'] = user_now.isoformat()
                result['user_timezone'] = tz_name
            except Exception:
                pass

        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'get_current_timestamp error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def calculate_timestamp(
    days_ago: int = 0,
    weeks_ago: int = 0,
    months_ago: int = 0,
    years_ago: int = 0,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Get the current Unix timestamp, optionally adjusted by days, weeks, months, or years.
    Use this to calculate timestamps for date filtering in search functions.
    Examples: "last week" = weeks_ago=1, "3 days ago" = days_ago=3, "a year ago" = years_ago=1

    :param days_ago: Number of days to subtract from current time (default: 0)
    :param weeks_ago: Number of weeks to subtract from current time (default: 0)
    :param months_ago: Number of months to subtract from current time (default: 0)
    :param years_ago: Number of years to subtract from current time (default: 0)
    :return: JSON with current_timestamp and calculated_timestamp (both in seconds)
    """
    try:
        from dateutil.relativedelta import relativedelta

        now = dt.datetime.now(dt.UTC)
        current_ts = int(now.timestamp())

        # Calculate the adjusted time
        total_days = days_ago + (weeks_ago * 7)
        adjusted = now - dt.timedelta(days=total_days)

        # Handle months and years separately (variable length)
        if months_ago > 0 or years_ago > 0:
            adjusted = adjusted - relativedelta(months=months_ago, years=years_ago)

        adjusted_ts = int(adjusted.timestamp())

        result = {
            'current_timestamp': current_ts,
            'current_iso': now.isoformat(),
            'calculated_timestamp': adjusted_ts,
            'calculated_iso': adjusted.isoformat(),
        }

        # Include the user's local time if timezone is available
        tz_name = __user__.get('timezone') if __user__ else None
        if tz_name:
            try:
                from zoneinfo import ZoneInfo

                user_tz = ZoneInfo(tz_name)
                result['user_local_iso'] = now.astimezone(user_tz).isoformat()
                result['calculated_local_iso'] = adjusted.astimezone(user_tz).isoformat()
                result['user_timezone'] = tz_name
            except Exception:
                pass

        return JSONCodec.dumps(result, ensure_ascii=False)
    except ImportError:
        # Fallback without dateutil

        now = dt.datetime.now(dt.UTC)
        current_ts = int(now.timestamp())
        total_days = days_ago + (weeks_ago * 7) + (months_ago * 30) + (years_ago * 365)
        adjusted = now - dt.timedelta(days=total_days)
        adjusted_ts = int(adjusted.timestamp())
        result = {
            'current_timestamp': current_ts,
            'current_iso': now.isoformat(),
            'calculated_timestamp': adjusted_ts,
            'calculated_iso': adjusted.isoformat(),
        }

        tz_name = __user__.get('timezone') if __user__ else None
        if tz_name:
            try:
                from zoneinfo import ZoneInfo

                user_tz = ZoneInfo(tz_name)
                result['user_local_iso'] = now.astimezone(user_tz).isoformat()
                result['calculated_local_iso'] = adjusted.astimezone(user_tz).isoformat()
                result['user_timezone'] = tz_name
            except Exception:
                pass

        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'calculate_timestamp error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# WEB SEARCH TOOLS
# =============================================================================


async def search_web(
    query: str,
    count: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search the public web for information. Best for current events, external references,
    or topics not covered in internal documents.

    :param query: The search query to look up
    :param count: Number of results to return (default: admin-configured value)
    :return: JSON with search results containing title, link, and snippet for each result
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        engine = await Config.get('web.search.engine')
        user = UserModel(**__user__) if __user__ else None

        configured = await Config.get('web.search.result_count')
        max_count = 5 if configured is None else configured
        count = max(1, min(count, max_count)) if count is not None else max_count

        results = await _search_web(__request__, engine, query, user)

        # Limit results
        results = results[:count] if results else []

        return JSONCodec.dumps(
            [{'title': r.title, 'link': r.link, 'snippet': r.snippet} for r in results],
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'search_web error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def fetch_url(
    url: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Fetch and extract the main text content from a web page URL.

    :param url: The URL to fetch content from
    :return: The extracted text content from the page
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        content, _ = await get_content_from_url(__request__, url)

        # Truncate if configured (WEB_FETCH_MAX_CONTENT_LENGTH)
        # Guard: content may be None if the web loader silently failed
        if content is not None:
            max_length = await Config.get('web.fetch.max_content_length')
            if max_length and max_length > 0 and len(content) > max_length:
                content = content[:max_length] + '\n\n[Content truncated...]'
        else:
            content = ''

        return content
    except Exception as e:
        log.warning(f'fetch_url error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# IMAGE GENERATION TOOLS
# =============================================================================


async def generate_image(
    prompt: str,
    __request__: Request = None,
    __user__: dict = None,
    __event_emitter__: callable = None,
    __chat_id__: str = None,
    __message_id__: str = None,
) -> str:
    """
    Generate an image based on a text prompt.

    :param prompt: A detailed description of the image to generate
    :return: Confirmation that the image was generated, or an error message
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        images = await image_generations(
            request=__request__,
            form_data=CreateImageForm(prompt=prompt),
            metadata=(
                {'channel_id': __chat_id__.removeprefix('channel:'), 'message_id': __message_id__}
                if isinstance(__chat_id__, str) and __chat_id__.startswith('channel:')
                else None
            ),
            user=user,
        )

        # Prepare file entries for the images
        image_files = [{'type': 'image', **img} for img in images]

        # Persist files to DB if chat context is available
        if is_saved_chat_id(__chat_id__) and __message_id__ and images:
            db_files = await Chats.add_message_files_by_id_and_message_id(
                __chat_id__,
                __message_id__,
                image_files,
            )
            if db_files is not None:
                image_files = db_files

        # Emit the images to the UI if event emitter is available
        if __event_emitter__ and image_files:
            await __event_emitter__(
                {
                    'type': 'chat:message:files',
                    'data': {
                        'files': image_files,
                    },
                }
            )
            # Return a message indicating the image is already displayed
            return JSONCodec.dumps(
                {
                    'status': 'success',
                    'message': (
                        'The image has been successfully generated and is already visible to the user in the chat. You '
                        'do not need to display or embed the image again - just acknowledge that it has been created.'
                    ),
                    'images': images,
                },
                ensure_ascii=False,
            )

        return JSONCodec.dumps({'status': 'success', 'images': images}, ensure_ascii=False)
    except Exception as e:
        log.exception(f'generate_image error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def edit_image(
    prompt: str,
    image_urls: list[str],
    __request__: Request = None,
    __user__: dict = None,
    __event_emitter__: callable = None,
    __chat_id__: str = None,
    __message_id__: str = None,
) -> str:
    """
    Transform one or more existing images according to a text prompt.
    Supports targeted edits such as adding, removing, replacing, inpainting, extending, or compositing image content.

    :param prompt: A description of the transformation to apply to the provided images
    :param image_urls: Source image URLs to modify or use as composition inputs
    :return: Confirmation that the images were edited, or an error message
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        images = await image_edits(
            request=__request__,
            form_data=EditImageForm(prompt=prompt, image=image_urls),
            metadata=(
                {'channel_id': __chat_id__.removeprefix('channel:'), 'message_id': __message_id__}
                if isinstance(__chat_id__, str) and __chat_id__.startswith('channel:')
                else None
            ),
            user=user,
        )

        # Prepare file entries for the images
        image_files = [{'type': 'image', **img} for img in images]

        # Persist files to DB if chat context is available
        if is_saved_chat_id(__chat_id__) and __message_id__ and images:
            db_files = await Chats.add_message_files_by_id_and_message_id(
                __chat_id__,
                __message_id__,
                image_files,
            )
            if db_files is not None:
                image_files = db_files

        # Emit the images to the UI if event emitter is available
        if __event_emitter__ and image_files:
            await __event_emitter__(
                {
                    'type': 'chat:message:files',
                    'data': {
                        'files': image_files,
                    },
                }
            )
            # Return a message indicating the image is already displayed
            return JSONCodec.dumps(
                {
                    'status': 'success',
                    'message': (
                        'The edited image has been successfully generated and is already visible to the user in the '
                        'chat. You do not need to display or embed the image again - just acknowledge that it has been '
                        'created.'
                    ),
                    'images': images,
                },
                ensure_ascii=False,
            )

        return JSONCodec.dumps({'status': 'success', 'images': images}, ensure_ascii=False)
    except Exception as e:
        log.exception(f'edit_image error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# USER INPUT TOOLS
# =============================================================================


async def ask_user(
    questions: list[dict],
    allow_other: bool = True,
    timeout_ms: int = 120_000,
    __event_call__: callable = None,
) -> str:
    """
    Ask the user clarifying questions before continuing.
    Use this when the next step depends on user intent, preference, or a tradeoff that cannot be inferred safely.

    :param questions: 1-3 question objects, each with id, header, question, and 2-3 options. Each option needs label and description.
    :param allow_other: Whether users may enter a free-form answer instead of choosing one of the options
    :param timeout_ms: How long the browser should keep the prompt open before cancelling it
    :return: JSON with status and answers keyed by question id
    """  # noqa: E501 - the model reads this docstring as the tool description
    try:
        if not isinstance(questions, list) or not 1 <= len(questions) <= 3:
            raise ValueError('ask_user requires 1-3 questions.')

        normalized_questions = []
        seen_ids = set()
        for index, question in enumerate(questions):
            if not isinstance(question, dict):
                raise ValueError('Each question must be an object.')

            question_id = str(question.get('id') or '').strip()[:64]
            if not question_id:
                raise ValueError('Each question requires a non-empty id.')
            if question_id in seen_ids:
                raise ValueError(f'Duplicate question id: {question_id}')
            seen_ids.add(question_id)

            options = question.get('options')
            if not isinstance(options, list) or not 2 <= len(options) <= 3:
                raise ValueError('Each question requires 2-3 options.')

            normalized_options = []
            for option in options:
                if not isinstance(option, dict):
                    raise ValueError('Each option must be an object.')

                label = str(option.get('label') or '').strip()[:80]
                description = str(option.get('description') or '').strip()[:240]
                if not label or not description:
                    raise ValueError('Each option requires a label and description.')

                normalized_options.append(
                    {
                        'label': label,
                        'description': description,
                    }
                )

            question_text = str(question.get('question') or '').strip()[:500]
            if not question_text:
                raise ValueError('Each question requires question text.')

            normalized_questions.append(
                {
                    'id': question_id,
                    'header': str(question.get('header') or '').strip()[:48] or f'Question {index + 1}',
                    'question': question_text,
                    'options': normalized_options,
                    'allow_other': bool(question.get('allow_other', allow_other)),
                }
            )

        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 60_000 <= timeout_ms <= 240_000:
            timeout_ms = 120_000

        if __event_call__ is None:
            return JSONCodec.dumps(
                {
                    'status': 'error',
                    'error': 'User input requires an active browser session with WebSocket connection.',
                },
                ensure_ascii=False,
            )

        output = await __event_call__(
            {
                'type': 'request:user_input',
                'data': {
                    'questions': normalized_questions,
                    'allow_other': allow_other,
                    'timeout_ms': timeout_ms,
                },
            }
        )

        if not isinstance(output, dict):
            return JSONCodec.dumps({'status': 'error', 'error': 'Invalid user input response.'}, ensure_ascii=False)
        if output.get('error'):
            return JSONCodec.dumps({'status': 'error', 'error': output.get('error')}, ensure_ascii=False)
        if output.get('status') == 'cancelled':
            return JSONCodec.dumps({'status': 'cancelled', 'answers': {}}, ensure_ascii=False)

        return JSONCodec.dumps(
            {
                'status': 'answered',
                'answers': output.get('answers', {}),
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'ask_user error: {e}')
        return JSONCodec.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)


# =============================================================================
# CODE INTERPRETER TOOLS
# =============================================================================


async def execute_code(
    code: str,
    __request__: Request = None,
    __user__: dict = None,
    __event_emitter__: callable = None,
    __event_call__: callable = None,
    __chat_id__: str = None,
    __message_id__: str = None,
    __metadata__: dict = None,
) -> str:
    """
    Execute Python code in a sandboxed environment and return the output.
    Use this to perform calculations, data analysis, generate visualizations,
    or run any Python code that would help answer the user's question.

    :param code: The Python code to execute
    :return: JSON with stdout, stderr, and result from execution
    """
    from uuid import uuid4

    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        # Sanitize code (strips ANSI codes and markdown fences)
        code = sanitize_code(code)

        # Import blocked modules from config (same as middleware)
        from local_llm.config import CODE_INTERPRETER_BLOCKED_MODULES

        # Add import blocking code if there are blocked modules
        if CODE_INTERPRETER_BLOCKED_MODULES:
            import textwrap

            blocking_code = textwrap.dedent(
                f"""
                import builtins

                BLOCKED_MODULES = {CODE_INTERPRETER_BLOCKED_MODULES}

                _real_import = builtins.__import__
                def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
                    if name.split('.')[0] in BLOCKED_MODULES:
                        importer_name = globals.get('__name__') if globals else None
                        if importer_name == '__main__':
                            raise ImportError(
                                f"Direct import of module {{name}} is restricted."
                            )
                    return _real_import(name, globals, locals, fromlist, level)

                builtins.__import__ = restricted_import
                """
            )
            code = blocking_code + '\n' + code

        engine = await Config.get('code_interpreter.engine', 'pyodide')
        if engine == 'pyodide':
            # Execute via frontend pyodide using bidirectional event call
            if __event_call__ is None:
                return JSONCodec.dumps(
                    {'error': 'Event call not available. WebSocket connection required for pyodide execution.'}
                )

            output = await __event_call__(
                {
                    'type': 'execute:python',
                    'data': {
                        'id': str(uuid4()),
                        'code': code,
                        'session_id': (__metadata__.get('session_id') if __metadata__ else None),
                        'files': (__metadata__.get('files', []) if __metadata__ else []),
                    },
                }
            )

            # Parse the output - pyodide returns dict with stdout, stderr, result
            if isinstance(output, dict):
                # Handle error responses from event_caller (e.g. session disconnected, timeout)
                if output.get('error') and not output.get('stdout') and not output.get('result'):
                    stderr = output['error']
                    stdout = ''
                    result = ''
                else:
                    stdout = output.get('stdout', '')
                    stderr = output.get('stderr', '')
                    result = output.get('result', '')
            else:
                stdout = ''
                stderr = ''
                result = str(output) if output else ''

        elif engine == 'jupyter':
            from local_llm.models.users import Users
            from local_llm.utils.code_interpreter import chat_files, execute_code_jupyter

            jupyter_auth = await Config.get('code_interpreter.jupyter.auth')
            files_user = await Users.get_user_by_id(__user__['id']) if __user__ and __user__.get('id') else None
            files, notes = await chat_files((__metadata__ or {}).get('files'), files_user)

            output = await execute_code_jupyter(
                await Config.get('code_interpreter.jupyter.url'),
                code,
                (await Config.get('code_interpreter.jupyter.auth_token') if jupyter_auth == 'token' else None),
                (await Config.get('code_interpreter.jupyter.auth_password') if jupyter_auth == 'password' else None),
                await Config.get('code_interpreter.jupyter.timeout'),
                files=files,
                notes=notes,
            )

            stdout = output.get('stdout', '')
            stderr = output.get('stderr', '')
            result = output.get('result', '')

        else:
            return JSONCodec.dumps({'error': f'Unknown code interpreter engine: {engine}'})

        # Handle image outputs (base64 encoded) - replace with uploaded URLs
        # Get actual user object for image upload (upload_image requires user.id attribute)
        # A benchmark run (benchmarks/evaluation/harness.py) keeps them inline
        # rather than store a file per plot in the owner's Files.
        benchmark = getattr(__request__.state, 'benchmark_harness', False) is True
        if __user__ and __user__.get('id') and not benchmark:
            from local_llm.models.users import Users
            from local_llm.utils.files import get_image_url_from_base64

            user = await Users.get_user_by_id(__user__['id'])

            # Extract and upload images from stdout
            if stdout and isinstance(stdout, str):
                stdout_lines = stdout.split('\n')
                for idx, line in enumerate(stdout_lines):
                    if 'data:image/png;base64' in line:
                        image_url = await get_image_url_from_base64(
                            __request__,
                            line,
                            __metadata__ or {},
                            user,
                        )
                        if image_url:
                            stdout_lines[idx] = f'![Output Image]({image_url})'
                stdout = '\n'.join(stdout_lines)

            # Extract and upload images from result
            if result and isinstance(result, str):
                result_lines = result.split('\n')
                for idx, line in enumerate(result_lines):
                    if 'data:image/png;base64' in line:
                        image_url = await get_image_url_from_base64(
                            __request__,
                            line,
                            __metadata__ or {},
                            user,
                        )
                        if image_url:
                            result_lines[idx] = f'![Output Image]({image_url})'
                result = '\n'.join(result_lines)

        response = {
            'status': 'success',
            'stdout': stdout,
            'stderr': stderr,
            'result': result,
        }

        return JSONCodec.dumps(response, ensure_ascii=False)
    except Exception as e:
        log.exception(f'execute_code error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# SANDBOX TOOLS
# =============================================================================
#
# The code interpreter's tools when its engine is `sandbox`: one microVM per
# chat with a persistent /workspace (docs/proposals/sandbox-code-interpreter.md).
# The manager on request.app.state.sandbox (sandbox/manager.py) gives the
# chat its sandbox; sandbox/workspace.py confines and carries out the file
# operations. Each tool does all its steps in one session, which holds the
# sandbox's lock, so no other call on the chat runs between them.


def sandbox_chat(request: Request | None, chat_id: str | None) -> str | None:
    """The chat whose sandbox a call uses: the parent chat for a sub-agent's request, else `chat_id`.

    utils/subagents.py sets `request.state.sandbox_chat_id` on the request it
    builds for a sub-agent, which nothing a client sends can set; the manager
    still checks that the user may use that chat.
    """
    parent = getattr(getattr(request, 'state', None), 'sandbox_chat_id', None)
    return parent if type(parent) is str and parent else chat_id


def shares_parent_sandbox(request: Request | None) -> bool:
    """Whether the request uses another chat's sandbox (sandbox_chat): a sub-agent's, or the parent's continuation
    after a background sub-agent. Such a request never syncs /workspace/uploads: its attachments are a few of the
    parent's, or a snapshot from an earlier turn, and the sync makes uploads hold exactly what it is given."""
    parent = getattr(getattr(request, 'state', None), 'sandbox_chat_id', None)
    return type(parent) is str and bool(parent)


async def configured_timeout() -> int:
    """The admin's default command timeout (`code_interpreter.sandbox.timeout`), clamped; TIMEOUT_DEFAULT_S when
    it is unset, stored as null (a cleared field) or not a valid value."""
    value = await Config.get(TIMEOUT_KEY, TIMEOUT_DEFAULT_S)
    if value is None or sandbox_setting_error(TIMEOUT_KEY, value) is not None:
        return TIMEOUT_DEFAULT_S
    return clamp_timeout(value)


def _code_run_failure(exc: BaseException) -> str:
    """What note_code_run records as the sandbox's own failure: empty for the model's mistakes (WorkspaceError),
    which are its result, as a command that fails, times out or is OOM-killed is; else the error's class name."""
    return '' if isinstance(exc, WorkspaceError) else f'sandbox: {type(exc).__name__}'


@asynccontextmanager
async def _sandbox_session(
    request: Request | None,
    user: dict | None,
    chat_id: str | None,
    metadata: dict | None,
    event_emitter: Callable[[dict], Awaitable[None]] | None,
    image: str | None = None,
    upload_notes: list[str] | None = None,
) -> AsyncIterator[SandboxSession]:
    """The chat's sandbox session, saying so through the event emitter while it waits for a free sandbox.

    The chat is sandbox_chat's: a sub-agent's request names its parent chat,
    whose sandbox it shares (owner decision Q6).

    With `upload_notes` given (`bash`, `view`), the chat's attached files
    (`metadata['files']`) are synced into /workspace/uploads first
    (sandbox/uploads.py), and the notes for files left out are appended to
    it; never for a request that shares its parent's sandbox
    (shares_parent_sandbox), which uses the uploads the parent's own calls
    synced.
    A sync that fails never refuses the call: a full workspace must still run
    `rm`. Its failure becomes one more note, with the reason only when it was
    written for the model; the details are logged.

    Raises:
        SandboxUnavailable: The app has no sandbox manager.
        SandboxRefused: There is no user, or the manager refuses the chat.
        WorkspaceError: `image` is not `data`, `web` or None.
        SandboxError: The manager could not start the sandbox.
        SandboxNotRunning: The sandbox stopped during the upload sync.
    """
    manager = getattr(getattr(getattr(request, 'app', None), 'state', None), 'sandbox', None)
    if manager is None:
        raise SandboxUnavailable('this server has no sandbox running')
    if image is not None and image not in get_args(ImageKey):
        raise WorkspaceError(f"image must be 'data' or 'web', not {image!r}")
    from local_llm.models.users import Users

    account = await Users.get_user_by_id(user['id']) if user and user.get('id') else None
    if account is None:
        raise SandboxRefused('no sandbox without a signed-in user')
    waited = False

    async def on_wait() -> None:
        nonlocal waited
        waited = True
        if event_emitter is not None:
            await event_emitter(
                {'type': 'status', 'data': {'description': 'Waiting for a free sandbox', 'done': False}}
            )

    chat = sandbox_chat(request, chat_id or (metadata or {}).get('chat_id'))
    if shares_parent_sandbox(request):
        upload_notes = None
    entered = False
    try:
        async with manager.session(chat, account, image=cast(ImageKey | None, image), on_wait=on_wait) as session:
            entered = True
            if waited and event_emitter is not None:
                await event_emitter({'type': 'status', 'data': {'description': 'Sandbox ready', 'done': True}})
            if upload_notes is not None:
                try:
                    upload_notes.extend(
                        # The owner is looked up only when the chat has files.
                        await sync_uploads(
                            session, (metadata or {}).get('files'), account, lambda: chat_owner(chat, account)
                        )
                    )
                except SandboxNotRunning:
                    raise
                except Exception as exc:
                    log.warning('the upload sync for chat %s failed', chat, exc_info=True)
                    why = (
                        exc.public if isinstance(exc, SandboxError) and exc.public else 'the copy failed on the server'
                    )
                    upload_notes.append(
                        f'{UPLOADS_NOT_COPIED} ({why}), so it may be missing files or hold an older set'
                    )
            yield session
    except Exception:
        # A wait that ends without a sandbox closes its status too, or the chat would show it waiting for good.
        if waited and not entered and event_emitter is not None:
            await event_emitter({'type': 'status', 'data': {'description': 'No sandbox could start', 'done': True}})
        raise


@contextmanager
def _model_input() -> Iterator[None]:
    """Checks of the model's arguments, before any sandbox opens: a ValueError or TypeError they raise is the model's
    to correct, so it becomes a WorkspaceError, the only error whose text _sandbox_error passes on as it is."""
    try:
        yield
    except WorkspaceError:
        raise
    except (ValueError, TypeError) as exc:
        raise WorkspaceError(str(exc)) from exc


#: How the note for a failed upload sync starts (_sandbox_session); `view` adds that note to its errors.
UPLOADS_NOT_COPIED = 'The attached files could not be copied into /workspace/uploads'


def _sandbox_error(tool: str, exc: Exception, notes: list[str] | None = None) -> str:
    """The tool result for a failure: JSON with `error`, the text sandbox_error_text gives."""
    return JSONCodec.dumps({'error': sandbox_error_text(tool, exc, notes)}, ensure_ascii=False)


def _file_tool_error(tool: str, exc: Exception, notes: list[str] | None = None) -> str:
    """_sandbox_error for `view`, `write_file` and `str_replace`, recording the sandbox's own failure with
    note_code_run (as a run of 0 ms), so a harness run never scores a broken sandbox as the model's mistake when the
    model gives up before a `bash` call. The model's own mistakes are not recorded: they are not code runs."""
    failure = _code_run_failure(exc)
    if failure:
        note_code_run(0, failure)
    return _sandbox_error(tool, exc, notes)


def sandbox_error_text(tool: str, exc: Exception, notes: list[str] | None = None) -> str:
    """The text for a failure, worded so the model can tell its own mistake from the sandbox's.

    The result goes to the model and on to its provider, so the text of an
    error that may carry internals (a Docker or database error, a host path)
    is logged and never returned: only the manager's refusals, text written
    for the model (SandboxError.public) and the model's own mistakes
    (WorkspaceError) are. Any other ValueError or TypeError, from a library
    or a bug, gets the fixed text too. A failed upload sync's note in
    `notes` is added to the message.
    """
    if isinstance(exc, SandboxUnavailable):
        log.warning('%s: the sandbox is not available: %s', tool, exc)
        message = 'The sandbox is not available on this server'
    elif isinstance(exc, SandboxRefused):
        # The manager's own text, naming the chat and why.
        message = f'The sandbox cannot be used in this chat: {exc}'
    elif isinstance(exc, SandboxError) and exc.public is not None:
        log.warning('%s: the sandbox failed: %s', tool, exc)
        message = f'The sandbox failed: {exc.public}'
    elif isinstance(exc, SandboxNotRunning):
        log.warning('%s: the sandbox stopped: %s', tool, exc)
        message = 'The sandbox failed: it stopped during the call; the next call starts it again'
    elif isinstance(exc, WorkspaceError):
        # A refused path or argument, a missing file, a second match: the model's to correct (_model_input).
        message = str(exc)
    else:
        log.exception('%s failed', tool)
        message = f'{tool} failed inside the sandbox service; try again, and say so if it keeps failing'
    return ' '.join([message, *(f'({note})' for note in notes or [] if note.startswith(UPLOADS_NOT_COPIED))])


def _flag(value: object, name: str) -> bool:
    """A yes/no argument from a tool call: a bool, or the text true or false in any case; None is false."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ('true', 'false'):
        return value.strip().lower() == 'true'
    raise WorkspaceError(f'{name} must be true or false, not {value!r}')


#: Told to the model when /workspace/outputs could not be compared before and after its command.
OUTPUTS_NOT_LISTED = '/workspace/outputs could not be listed, so no files from it were attached to the reply'
#: Told to the model when either listing was cut short.
OUTPUTS_CUT = (
    '/workspace/outputs holds too many files to list them all, so only the newest were checked for new or '
    'changed files; move finished files out of it'
)


async def _outputs_before(session: SandboxSession) -> sandbox_outputs.Listing | None:
    """What to compare /workspace/outputs with after the command: the listing the last call took after its command,
    else one taken now; None when it cannot be listed, which never stops the command.

    Comparing with the last call's listing counts a file `write_file` or `str_replace` put there in between as new.
    The manager keeps that listing per sandbox while it runs (SandboxSession.outputs_memory), so a sandbox started
    again lists afresh. It is forgotten until this call ends well (_bash_outputs), so a call cut short while it
    attaches (a Stop, an error) leaves the next one to list before its own command rather than attach this call's
    files twice; a call stopped during its command, before anything was attached, puts it back (bash).
    """
    memory = session.outputs_memory
    before, memory.listing = memory.listing, None
    if before is not None:
        return before
    try:
        return await sandbox_outputs.list_outputs(session)
    except SandboxError:
        log.warning('bash: the sandbox failed while listing /workspace/outputs', exc_info=True)
        return None


async def _keep_outputs_listing(session: SandboxSession) -> None:
    """Before `write_file` or `str_replace` writes, keep a listing of /workspace/outputs when none is kept yet.

    The next `bash` call compares with the kept listing (_outputs_before), so a file written into
    /workspace/outputs now counts as new there even when no `bash` call has run in this sandbox yet. A listing that
    fails is left out, and the write goes ahead.
    """
    memory = session.outputs_memory
    if memory.listing is not None:
        return
    try:
        memory.listing = await sandbox_outputs.list_outputs(session)
    except SandboxError:
        log.warning('the sandbox failed while listing /workspace/outputs before a write', exc_info=True)


async def _chat_left(memory: OutputsMemory, chat_id: str | None, account: UserModel | None) -> int:
    """What the chat's cap on sandbox outputs (OUTPUT_CHAT_CAP_BYTES, owner decision Q22) has left.

    It counts the File rows the server marked as this chat's (sandbox_outputs.chat_usage), previews included, whether
    or not they are linked to a message, so the count outlives the sandbox and the server. An unsaved chat's id is
    not a UUID the database checks, so its rows count only when they are also the caller's, as its sandbox is
    (Q12). The same query's last row per path joins the sandbox's own record for content de-duplication.
    """
    saved = bool(chat_id and is_saved_chat_id(chat_id))
    owner = None if saved else (account.id if account is not None else '')
    used, latest = await sandbox_outputs.chat_usage(chat_id or '', owner)
    for path, record in latest.items():
        memory.stored.setdefault(path, record)
    return max(0, OUTPUT_CHAT_CAP_BYTES - used)


async def _bash_outputs(
    session: SandboxSession,
    before: sandbox_outputs.Listing | None,
    request: Request | None,
    user: dict | None,
    chat_id: str | None,
    message_id: str | None,
    *,
    upload: bool,
    cap_chat: str | None = None,
) -> tuple[list[dict], list[str], list[dict]]:
    """The files new or changed in /workspace/outputs since `before`, attached (sandbox/outputs.py).

    They link to `message_id` in `chat_id` and count against `cap_chat`'s cap
    (the sandbox's chat: a sub-agent's parent, Q25); None means `chat_id`.

    Returns the tool result's `outputs`, notes for the model, and the new
    message files for the `files` event: whatever was stored, even when a
    later step failed. It never raises but for a cancellation: the command's
    own result is kept whatever happens here, and a sandbox that stopped
    meanwhile is a note, not a failed call. The listing taken after the
    command is kept for the next call only when everything here went well.
    """
    notes: list[str] = []
    try:
        after = await sandbox_outputs.list_outputs(session)
    except SandboxError:
        log.warning('bash: the sandbox failed while listing /workspace/outputs', exc_info=True)
        after = None
    if before is None or after is None:
        # A listing taken now still serves the next call.
        session.outputs_memory.listing = after
        return [], [OUTPUTS_NOT_LISTED], []
    if not before.complete or not after.complete:
        notes.append(OUTPUTS_CUT)
    entries = sandbox_outputs.changed_entries(before, after)
    collected = sandbox_outputs.Collected()
    memory = session.outputs_memory
    if entries:
        try:
            from local_llm.models.users import Users

            account = await Users.get_user_by_id(user['id']) if user and user.get('id') else None
            await sandbox_outputs.collect(
                session,
                entries,
                request=request,
                user=account,
                chat_id=chat_id,
                message_id=message_id,
                upload=upload,
                chat_left=await _chat_left(memory, cap_chat or chat_id, account) if upload else None,
                stored=memory.stored,
                into=collected,
                cap_chat_id=cap_chat,
            )
        except Exception:
            log.exception('bash: attaching the files in /workspace/outputs failed')
            notes.append('some new files in /workspace/outputs could not be attached because of a server error')
            done = {item['path'] for item in collected.outputs}
            for entry in entries:
                if f'outputs/{entry.name}' not in done:
                    collected.outputs.append({**sandbox_outputs.describe(entry), 'reason': 'a server error came first'})
            return collected.outputs, notes, collected.files
    if collected.error is not None:
        log.warning('bash: the sandbox failed while reading /workspace/outputs: %s', collected.error)
        notes.append('the sandbox stopped while the new files in /workspace/outputs were read; see each reason')
    else:
        session.outputs_memory.listing = after
    return collected.outputs, notes, collected.files


class _Packages:
    """One call's package telemetry (sandbox/telemetry.py); a no-op when app.state.sandbox_telemetry is None.

    `begin` before the command and `gather` after it run inside the session
    (the latter for at most telemetry.COLLECT_TIMEOUT_S); `finish` after the
    session hands the rest (the mirror's log, the database write) to a
    background task, so the call never waits for it. None of them raises
    but a cancellation.
    """

    def __init__(self, request: Request | None, chat_id: str | None, user: dict | None) -> None:
        state = getattr(getattr(request, 'app', None), 'state', None)
        telemetry = getattr(state, 'sandbox_telemetry', None)
        manager = getattr(state, 'sandbox', None)
        self._telemetry = telemetry if isinstance(telemetry, PackageTelemetry) else None
        self._manager: SandboxManager | None = manager if isinstance(manager, SandboxManager) else None
        self._request = request
        self._chat_id = chat_id or ''
        self._caller = (user or {}).get('id')
        self._context: PackageContext | None = None
        self._pending: list[Pending] = []

    def begin(self, session: SandboxSession) -> None:
        if self._telemetry is not None and self._manager is not None:
            self._context = self._telemetry.begin(self._manager, session, self._chat_id, self._request, self._caller)

    async def gather(self, session: SandboxSession, result: ExecResult) -> None:
        if self._telemetry is not None and self._manager is not None:
            self._pending = await self._telemetry.gather(self._manager, session, self._context, result)

    def finish(self) -> None:
        if self._telemetry is not None and self._manager is not None:
            self._telemetry.finish(self._manager, self._pending)


async def _emit_output_files(event_emitter: Callable[[dict], Awaitable[None]] | None, files: list[dict]) -> None:
    """Send the `files` event with the message's new files.

    Only the new ones: both readers merge the event into what the message
    already has rather than replace it, the chat page by id, then url, then
    whole entry (lib/chat/history.ts `mergeFiles`), and socket/main.py into
    the saved list (`merge_message_files`). A failure is logged, never raised.
    """
    if not files or event_emitter is None:
        return
    try:
        await event_emitter({'type': 'files', 'data': {'files': files}})
    except Exception:
        log.exception('bash: the files event for the outputs failed')


async def bash(
    command: str,
    timeout_s: int | None = None,
    image: str | None = None,
    __request__: Request | None = None,
    __user__: dict | None = None,
    __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
    __chat_id__: str | None = None,
    __message_id__: str | None = None,
    __metadata__: dict | None = None,
) -> str:
    """
    Run a bash command in this chat's sandbox: a Linux machine of its own, without internet access, whose
    working directory /workspace keeps its files for the whole chat. Commands run as an unprivileged user,
    without sudo. Each call starts a new shell in /workspace; nothing keeps running between calls, so save
    what you need to files. Print what you want to see; each of stdout and stderr is cut to its first and
    last 10,000 characters. A command is at most 100,000 bytes: for a longer script, write it with
    write_file and run the file.

    :param command: The bash command or script to run
    :param timeout_s: Seconds before the command is stopped, 1 to 300 (default: the server's setting, normally
        60); a value outside that range is brought into it
    :param image: The machine to run it on, keeping /workspace: 'data' (Python with numpy, pandas, scipy,
        scikit-learn and matplotlib; R with the tidyverse, data.table, lme4 and survival; TeX Live with latexmk;
        git, sqlite3, DuckDB and poppler-utils) or 'web' (Node.js with TypeScript, tsx, ESLint, Prettier and
        Playwright with Chromium). Leave it out to use the one already running ('data' when none is)
    :return: JSON with returncode, stdout, stderr, timed_out, truncated, and outputs: the files the command
        made or changed in /workspace/outputs, which are attached to your reply for the user to see (a file
        not attached says why)
    """
    chat_id = __chat_id__ or (__metadata__ or {}).get('chat_id')
    message_id = __message_id__ or (__metadata__ or {}).get('message_id')
    # A benchmark run (benchmarks/evaluation/harness.py) lists the outputs but stores none in the owner's Files.
    upload = getattr(getattr(__request__, 'state', None), 'benchmark_harness', False) is not True
    started = time.monotonic()
    try:
        with _model_input():
            requested = _line_arg(timeout_s, 'timeout_s')
            requested = None if requested is None else clamp_timeout(requested)
        # Left out, it is the admin's setting (configured_timeout).
        timeout = await configured_timeout() if requested is None else requested
        with _model_input():
            argv = wrap_command(command, timeout)
        notes: list[str] = []
        packages = _Packages(__request__, sandbox_chat(__request__, chat_id), __user__)
        async with _sandbox_session(
            __request__, __user__, __chat_id__, __metadata__, __event_emitter__, image, upload_notes=notes
        ) as session:
            packages.begin(session)
            # Every listing runs in a session, which holds the chat's lock, so nothing else touches
            # /workspace/outputs during a call; what other tools write there between calls is caught by comparing
            # with the last call's listing (_outputs_before).
            before = await _outputs_before(session)
            try:
                result = await session.exec(argv, timeout)
            except BaseException:
                # Nothing was attached yet, so the listing from before the command still holds: the next call
                # compares with it and attaches what a stopped or failed command left.
                session.outputs_memory.listing = before
                raise
            found, output_notes, files = await _bash_outputs(
                session,
                before,
                __request__,
                __user__,
                chat_id,
                message_id,
                upload=upload,
                cap_chat=sandbox_chat(__request__, chat_id),
            )
            # Last in the session: the events the command's processes recorded, its misses, and the mirror's log.
            await packages.gather(session, result)
        packages.finish()
    except Exception as exc:
        note_code_run((time.monotonic() - started) * 1000, _code_run_failure(exc))
        return _sandbox_error('bash', exc)
    # The command's own failure (an exit status, a timeout, an OOM kill) is the model's result, not the sandbox's.
    note_code_run((time.monotonic() - started) * 1000)
    await _emit_output_files(__event_emitter__, files)
    response: dict = {
        'returncode': result.returncode,
        'stdout': result.stdout,
        # As the Jupyter engine does: the model sees why an attached file is missing.
        'stderr': '\n'.join(filter(None, [result.stderr, *notes])),
        'timed_out': result.timed_out,
        'truncated': result.truncated,
        'outputs': found,
    }
    if output_notes:
        response['outputs_note'] = '; '.join(output_notes)
    return JSONCodec.dumps(response, ensure_ascii=False)


async def run_code_in_sandbox(
    code: str,
    *,
    request: Request | None,
    user: dict | None,
    chat_id: str | None,
    message_id: str | None,
    metadata: dict | None,
    event_emitter: Callable[[dict], Awaitable[None]] | None = None,
    what: str = 'the code',
    sync: bool = True,
) -> dict:
    """Run a block of Python in the chat's sandbox: the tag path's `<code_interpreter>` blocks and the Run endpoint.

    The code is written to /workspace/.runs/<n>.py (sandbox/runs.py) and run
    with `python` on the `data` image, as a `bash` call would run it, with the
    configured timeout, the chat's uploads synced first and its outputs
    collected after (owner decision Q25: every path collects its own). With
    `message_id`, the outputs link to that message and the `files` event is
    sent; without one (the Run endpoint) they are stored and counted against
    the chat's cap but linked to nothing. With `sync` off (the Run endpoint,
    which does not know the chat's attachments), /workspace/uploads is left
    as the chat's last call synced it rather than emptied.

    Returns:
        On success: `stdout`, `stderr` (with the upload and output notes),
        `result` (empty: nothing is captured inline), `returncode`,
        `timed_out`, `truncated`, `path` (the run's file), `outputs` (as
        `bash` lists them) and `files` (the stored files' descriptors). On
        failure: `error`, worded for the model as the tools' errors are.
        Each call is recorded with note_code_run, as failed only when the
        sandbox itself failed.
    """
    upload = getattr(getattr(request, 'state', None), 'benchmark_harness', False) is not True
    started = time.monotonic()
    notes: list[str] = []
    try:
        with _model_input():
            if type(code) is not str:
                raise WorkspaceError(f'the code must be text, not {type(code).__name__}')
            data = code.encode('utf-8')
        timeout = await configured_timeout()
        packages = _Packages(request, sandbox_chat(request, chat_id or (metadata or {}).get('chat_id')), user)
        async with _sandbox_session(
            request, user, chat_id, metadata, event_emitter, image='data', upload_notes=notes if sync else None
        ) as session:
            packages.begin(session)
            before = await _outputs_before(session)
            try:
                number = await sandbox_runs.next_run(session)
                await sandbox_files.write(session, sandbox_runs.run_path(number), data, overwrite=False)
                result = await session.exec(wrap_command(sandbox_runs.run_command(number), timeout), timeout)
            except BaseException:
                # As in bash: nothing was attached yet, so the next call compares with the listing from before.
                session.outputs_memory.listing = before
                raise
            found, output_notes, files = await _bash_outputs(
                session,
                before,
                request,
                user,
                chat_id,
                message_id,
                upload=upload,
                cap_chat=sandbox_chat(request, chat_id),
            )
            await packages.gather(session, result)
        packages.finish()
    except Exception as exc:
        note_code_run((time.monotonic() - started) * 1000, _code_run_failure(exc))
        return {'error': sandbox_error_text(what, exc, notes)}
    note_code_run((time.monotonic() - started) * 1000)
    if message_id:
        await _emit_output_files(event_emitter, files)
    return {
        'stdout': result.stdout,
        'stderr': '\n'.join(filter(None, [result.stderr, *notes, *output_notes])),
        'result': '',
        'returncode': result.returncode,
        'timed_out': result.timed_out,
        'truncated': result.truncated,
        'path': sandbox_runs.run_path(number),
        'outputs': found,
        'files': files,
    }


async def view(
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
    __request__: Request | None = None,
    __user__: dict | None = None,
    __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
    __chat_id__: str | None = None,
    __message_id__: str | None = None,
    __metadata__: dict | None = None,
) -> str:
    """
    View a file or a directory in this chat's sandbox. A text file comes back as numbered lines (the numbers
    are not part of the file), a page of about 20,000 characters at a time: when there is more, the result
    gives next_start_line to ask for next. A directory comes back as a listing two levels deep without
    hidden entries (except .runs), and a PNG, JPEG, GIF or WebP image as the image itself. Files over 10 MiB,
    images over 2 MiB, 8192 pixels a side or 40 megapixels, and animated images are refused; work with those
    through bash.

    :param path: The path, relative to /workspace or absolute under /workspace
    :param start_line: The first line of a text file to show, from 1 (default 1; ignored for a directory or an
        image)
    :param end_line: The last line of a text file to show, inclusive (default: the end of the file)
    :return: JSON with the numbered lines or the listing, or the image
    """
    try:
        with _model_input():
            sandbox_files.confine(path)
            first = _line_arg(start_line, 'start_line')
            last = _line_arg(end_line, 'end_line')
    except Exception as exc:
        return _file_tool_error('view', exc)
    # Synced as for bash, so the attached files are there from the chat's first call. The notes are bash's, except
    # that a failed sync is named in an error, which a missing upload would otherwise show without a reason.
    notes: list[str] = []
    try:
        async with _sandbox_session(
            __request__, __user__, __chat_id__, __metadata__, __event_emitter__, upload_notes=notes
        ) as session:
            shown = await sandbox_files.view(session, path, first, last)
    except Exception as exc:
        return _file_tool_error('view', exc, notes)
    # An image is returned as its data: URI, which the tool-result path shows to a vision model.
    return shown if isinstance(shown, str) else JSONCodec.dumps(shown, ensure_ascii=False)


async def write_file(
    path: str,
    content: str,
    overwrite: bool = False,
    __request__: Request | None = None,
    __user__: dict | None = None,
    __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
    __chat_id__: str | None = None,
    __message_id__: str | None = None,
    __metadata__: dict | None = None,
) -> str:
    """
    Write a text file in this chat's sandbox, creating its parent directories. An existing file is refused
    unless overwrite is true; to change part of a file, use str_replace. The file is replaced whole or not at
    all, keeping its permissions; a read-only file is refused.

    :param path: The path, relative to /workspace or absolute under /workspace
    :param content: The whole content of the file
    :param overwrite: Replace the file if it exists (default false)
    :return: JSON with the path written and bytes_written
    """
    try:
        with _model_input():
            sandbox_files.confine_file(path)
            if type(content) is not str:
                raise WorkspaceError(f'content must be text, not {type(content).__name__}')
            replace = _flag(overwrite, 'overwrite')
            data = content.encode('utf-8')
        async with _sandbox_session(__request__, __user__, __chat_id__, __metadata__, __event_emitter__) as session:
            await _keep_outputs_listing(session)
            written = await sandbox_files.write(session, path, data, overwrite=replace)
    except Exception as exc:
        return _file_tool_error('write_file', exc)
    return JSONCodec.dumps({'path': written, 'bytes_written': len(data)}, ensure_ascii=False)


async def str_replace(
    path: str,
    old_str: str,
    new_str: str,
    __request__: Request | None = None,
    __user__: dict | None = None,
    __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
    __chat_id__: str | None = None,
    __message_id__: str | None = None,
    __metadata__: dict | None = None,
) -> str:
    """
    Edit a text file in this chat's sandbox by replacing one exact piece of text. old_str must occur exactly
    once in the file, whitespace included; when it occurs several times, include more of the surrounding
    lines.

    :param path: The path, relative to /workspace or absolute under /workspace
    :param old_str: The exact text to replace (without the line numbers view shows)
    :param new_str: The text to put in its place
    :return: JSON with the path, the edited lines and a few numbered lines around the edit
    """
    try:
        with _model_input():
            sandbox_files.confine(path)
            sandbox_files.check_replacement(old_str, new_str)
        async with _sandbox_session(__request__, __user__, __chat_id__, __metadata__, __event_emitter__) as session:
            await _keep_outputs_listing(session)
            edited = await sandbox_files.str_replace(session, path, old_str, new_str)
    except Exception as exc:
        return _file_tool_error('str_replace', exc)
    return JSONCodec.dumps(edited, ensure_ascii=False)


# =============================================================================
# MEMORY TOOLS
# =============================================================================


async def list_memory_paths(
    query: str = '',
    count: int = 100,
    type: str = 'all',
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    List saved memory paths to find existing memory groups before writing or moving memories.

    :param query: Optional query to filter memory paths or contents
    :param count: Maximum number of paths to return
    :param type: "user", "context", or "all"
    :return: JSON with memory paths, counts, children, and update times
    """
    try:
        user = UserModel(**__user__) if __user__ else None
        result = await _list_memory_paths(
            ListMemoryPathsForm(
                query=query or None,
                type=type if type in {'user', 'context', 'all'} else 'all',
                limit=count,
            ),
            user,
        )
        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'list_memory_paths error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def read_memory_path(
    path: str,
    count: int = 50,
    type: str = 'all',
    include_children: bool = True,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Read saved memories at a memory path, including nearby parent and child paths.

    :param path: Memory path to read
    :param count: Maximum number of memories to return
    :param type: "user", "context", or "all"
    :param include_children: Include memories under child paths
    :return: JSON with parent paths, child paths, and memories at the path
    """
    try:
        user = UserModel(**__user__) if __user__ else None
        result = await _read_memory_path(
            ReadMemoryPathForm(
                path=path,
                type=type if type in {'user', 'context', 'all'} else 'all',
                include_children=include_children,
                limit=count,
            ),
            user,
        )
        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'read_memory_path error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def search_memories(
    query: str = '',
    count: int = 5,
    type: str = 'all',
    path: str | None = None,
    memory_id: str | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search or browse saved memories by content, path, type, or memory ID.

    :param query: Optional query to search memory content and path
    :param count: Number of memories to return (default 5)
    :param type: "user", "context", or "all"
    :param path: Optional memory path to search around
    :param memory_id: Optional exact memory ID to read
    :return: JSON with matching memories and their dates
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        memories = await _search_memories(
            SearchMemoriesForm(
                query=query or None,
                type=type if type in {'user', 'context', 'all'} else 'all',
                path=path,
                memory_id=memory_id,
                limit=count,
            ),
            user,
        )

        if not memories:
            return JSONCodec.dumps([])

        return JSONCodec.dumps(
            [
                {
                    'id': memory.id,
                    'type': memory.type,
                    'path': memory.path,
                    'content': memory.content,
                    'created_at': time.strftime('%Y-%m-%d', time.localtime(memory.created_at)),
                    'updated_at': time.strftime('%Y-%m-%d', time.localtime(memory.updated_at)),
                }
                for memory in memories
            ],
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'search_memories error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def add_memory(
    content: str,
    type: str = 'user',
    path: str | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Save enduring information that can improve future chats.

    Save stable preferences, goals, projects, relationships, habits, and standing instructions.
    Do not save one-off activity, meals, routine daily events, temporary mood, or other short-lived details
    unless the user explicitly asks you to remember them.

    :param content: The memory content to store
    :param type: Use "user" for facts/preferences about the user, or "context" for other durable context
    :param path: Optional stable memory address for grouping related memories
    :return: Confirmation that the memory was stored
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        memory = await _add_memory(
            __request__,
            AddMemoryForm(content=content, type=Memories.normalize_memory_type(type), path=path),
            user,
        )

        return JSONCodec.dumps(
            {'status': 'success', 'id': memory.id, 'type': memory.type, 'path': memory.path},
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'add_memory error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def update_memory(
    operations: list[dict],
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Apply a batch of memory changes after learning enduring information.

    Use type "user" for facts, preferences, or instructions about the user.
    Use type "context" for other durable context that may help future chats.
    Do not save one-off activity, meals, routine daily events, temporary mood, or other short-lived details
    unless the user explicitly asks you to remember them.
    Path is optional. Use it as a stable memory address to group related memories.
    Prefer an existing path from list_memory_paths when one fits.
    Leave path empty when no useful grouping is clear.
    On replace, leave path out to keep the memory's current path; an empty path clears it.

    Operation shapes:
    - {"action": "add", "content": "...", "type": "user"|"context", "path": "..."}
    - {"action": "replace", "id": "...", "content": "...", "type": "user"|"context", "path": "..."}
    - {"action": "move", "id": "...", "path": "..."}
    - {"action": "remove", "id": "..."}

    :param operations: Memory operations to apply in one request
    :return: JSON with operation results
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None
        operation_results = await _update_memories(
            __request__,
            UpdateMemoriesForm(operations=operations),
            user,
        )
        return JSONCodec.dumps(operation_results, ensure_ascii=False)
    except Exception as e:
        log.exception(f'update_memory error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def replace_memory_content(
    memory_id: str,
    content: str,
    type: str | None = None,
    path: str | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Update an existing saved memory by its ID when its content needs correction.

    :param memory_id: The ID of the memory to update
    :param content: The new content for the memory
    :param type: Optional "user" or "context" type for the updated memory
    :param path: Optional stable memory address for grouping related memories
    :return: Confirmation that the memory was updated
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        memory = await update_memory_by_id(
            memory_id=memory_id,
            request=__request__,
            form_data=MemoryUpdateModel(
                content=content,
                type=Memories.normalize_memory_type(type) if type else None,
                path=path,
            ),
            user=user,
        )

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': memory.id,
                'type': memory.type,
                'path': memory.path,
                'content': memory.content,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'replace_memory_content error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def delete_memory(
    memory_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Delete a saved memory by its ID.

    :param memory_id: The ID of the memory to delete
    :return: Confirmation that the memory was deleted
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        result = await Memories.delete_memory_by_id_and_user_id(memory_id, user.id)

        if result:
            await ASYNC_VECTOR_DB_CLIENT.delete(collection_name=f'user-memory-{user.id}', ids=[memory_id])
            return JSONCodec.dumps(
                {'status': 'success', 'message': f'Memory {memory_id} deleted'},
                ensure_ascii=False,
            )
        else:
            return JSONCodec.dumps({'error': 'Memory not found or access denied'})
    except Exception as e:
        log.exception(f'delete_memory error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def list_memories(
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    List all stored memories for the user, including IDs and timestamps.

    :return: JSON list of all memories with id, content, and dates
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    try:
        user = UserModel(**__user__) if __user__ else None

        memories = await Memories.get_memories_by_user_id(user.id)

        if memories:
            memory_rows = [
                {
                    'id': m.id,
                    'type': m.type,
                    'path': m.path,
                    'content': m.content,
                    'created_at': time.strftime('%Y-%m-%d %H:%M', time.localtime(m.created_at)),
                    'updated_at': time.strftime('%Y-%m-%d %H:%M', time.localtime(m.updated_at)),
                }
                for m in memories
            ]
            return JSONCodec.dumps(memory_rows, ensure_ascii=False)
        else:
            return JSONCodec.dumps([])
    except Exception as e:
        log.exception(f'list_memories error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# NOTES TOOLS
# =============================================================================


async def search_notes(
    query: str,
    count: int = 5,
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search the user's saved notes by title and content.

    :param query: The search query to find matching notes
    :param count: Maximum number of results to return (default: 5)
    :param start_timestamp: Only include notes updated after this Unix timestamp (seconds)
    :param end_timestamp: Only include notes updated before this Unix timestamp (seconds)
    :return: JSON with matching notes containing id, title, and content snippet
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if count < 1:
        return JSONCodec.dumps([])

    try:
        user_id = __user__.get('id')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        result = await Notes.search_notes(
            user_id=user_id,
            filter={
                'query': query,
                'user_id': user_id,
                'group_ids': user_group_ids,
                'permission': 'read',
                # The range is part of the query (notes keep nanoseconds): filtering
                # newest matches afterwards found nothing in a past range (#181).
                'updated_after': start_timestamp * 1_000_000_000 if start_timestamp else None,
                'updated_before': end_timestamp * 1_000_000_000 if end_timestamp else None,
            },
            skip=0,
            limit=count,
        )

        notes = []
        for note in result.items:
            # Extract a snippet from the markdown content
            content_snippet = ''
            if note.data and note.data.get('content', {}).get('md'):
                md_content = note.data['content']['md']
                # Find the first matching word to center the snippet around.
                match = None
                for word in query.lower().split():
                    match = find_in_lowered(md_content, word)
                    if match:
                        break

                if match:
                    snippet_start = max(0, match[0] - 50)
                    snippet_end = min(len(md_content), match[1] + 100)
                    content_snippet = (
                        ('...' if snippet_start > 0 else '')
                        + md_content[snippet_start:snippet_end]
                        + ('...' if snippet_end < len(md_content) else '')
                    )
                else:
                    content_snippet = md_content[:150] + ('...' if len(md_content) > 150 else '')

            notes.append(
                {
                    'id': note.id,
                    'title': note.title,
                    'snippet': content_snippet,
                    'updated_at': note.updated_at,
                }
            )

            if len(notes) >= count:
                break

        return JSONCodec.dumps(notes, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_notes error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def view_note(
    note_id: str,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    Get the full content of a note by its ID.

    :param note_id: The ID of the note to retrieve
    :return: JSON with the note's id, title, and full markdown content
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        note = await Notes.get_note_by_id(note_id)

        if not note:
            return JSONCodec.dumps({'error': 'Note not found'})

        # Check access permission
        user_id = __user__.get('id')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        from local_llm.models.access_grants import AccessGrants

        if (
            __user__.get('role') != 'admin'
            and note.user_id != user_id
            and not await AccessGrants.has_access(
                user_id=user_id,
                resource_type='note',
                resource_id=note.id,
                permission='read',
                user_group_ids=set(user_group_ids),
            )
            and not is_folder_entry(__model_knowledge__, 'note', note.id)
        ):
            return JSONCodec.dumps({'error': 'Access denied'})

        # Extract markdown content
        content = ''
        if note.data and note.data.get('content', {}).get('md'):
            content = note.data['content']['md']

        return JSONCodec.dumps(
            {
                'id': note.id,
                'title': note.title,
                'content': content,
                'updated_at': note.updated_at,
                'created_at': note.created_at,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'view_note error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def write_note(
    title: str,
    content: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Create a new note with the given title and content.

    :param title: The title of the new note
    :param content: The markdown content for the note
    :return: JSON with success status and new note id
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.notes import NoteForm

        user_id = __user__.get('id')

        form = NoteForm(
            title=title,
            data={'content': {'md': content}},
            access_grants=[],  # Private by default - only owner can access
        )

        new_note = await Notes.insert_new_note(user_id, form)

        if not new_note:
            return JSONCodec.dumps({'error': 'Failed to create note'})

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': new_note.id,
                'title': new_note.title,
                'created_at': new_note.created_at,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'write_note error: {e}')
        return JSONCodec.dumps({'error': str(e)})


class _NoteOperationError(Exception):
    """A note operation that can't be applied; ``payload`` is the error the tool returns."""

    def __init__(self, error: str, code: str, **details):
        super().__init__(error)
        self.payload = {'error': error, 'code': code, **details}


def _whole_replacement(operation: dict, idx: int, operation_count: int) -> str:
    if operation_count != 1:
        raise _NoteOperationError('replace operation must be the only operation', 'invalid_operations', index=idx)
    replacement = operation.get('content')
    if not isinstance(replacement, str):
        raise _NoteOperationError('replace operation content must be a string', 'invalid_content', index=idx)
    return replacement


def _range_operation(operation: dict, idx: int, current_content: str) -> dict:
    start = operation.get('start')
    end = operation.get('end')
    replacement = operation.get('content')
    expected = operation.get('expected')
    if not isinstance(start, int) or not isinstance(end, int):
        raise _NoteOperationError('operation start and end must be integers', 'invalid_range', index=idx)
    if not isinstance(replacement, str):
        raise _NoteOperationError('operation content must be a string', 'invalid_content', index=idx)
    if start < 0 or end < start or end > len(current_content):
        raise _NoteOperationError('operation range is out of bounds', 'range_out_of_bounds', index=idx)
    if expected is not None and current_content[start:end] != expected:
        raise _NoteOperationError(
            'operation expected text does not match current content', 'expected_mismatch', index=idx
        )
    return {'start': start, 'end': end, 'content': replacement}


def _apply_ranges(range_operations: list[dict], current_content: str) -> str:
    range_operations.sort(key=lambda operation: operation['start'])
    previous_end = 0
    for idx, operation in enumerate(range_operations):
        if operation['start'] < previous_end:
            raise _NoteOperationError('operation ranges must not overlap', 'overlapping_operations', index=idx)
        previous_end = operation['end']

    # Back to front, so each edit leaves the offsets of the ones before it intact.
    content = current_content
    for operation in reversed(range_operations):
        content = content[: operation['start']] + operation['content'] + content[operation['end'] :]
    return content


def _apply_note_operations(operations, current_content: str) -> tuple[str, int]:
    """Return the note's new markdown and how many operations made it, or raise _NoteOperationError."""
    if not isinstance(operations, list) or len(operations) == 0:
        raise _NoteOperationError('operations must be a non-empty list', 'invalid_operations')

    range_operations = []
    for idx, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise _NoteOperationError('each operation must be an object', 'invalid_operation', index=idx)
        action = operation.get('action')
        if action == 'replace':
            return _whole_replacement(operation, idx, len(operations)), 1
        if action != 'replace_range':
            raise _NoteOperationError('unknown operation action', 'invalid_action', index=idx, action=action)
        range_operations.append(_range_operation(operation, idx, current_content))

    return _apply_ranges(range_operations, current_content), len(range_operations)


def _note_update(note, content: str, title: str | None) -> dict:
    # The editor regenerates json and html from md, so stale copies are cleared.
    data = note.data or {}
    update_data = {
        'data': {
            **data,
            'content': {
                **(data.get('content') or {}),
                'json': None,
                'html': '',
                'md': content,
            },
        }
    }
    if title:
        update_data['title'] = title
    return update_data


async def replace_note_content(
    note_id: str,
    content: str | None = None,
    operations: list[dict] | None = None,
    title: str | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Update an existing note by replacing the whole markdown content or applying range operations.

    :param note_id: The ID of the note to update
    :param content: The new markdown content for a whole-note update
    :param operations: Optional note operations:
    - {"action": "replace", "content": "..."}
    - {"action": "replace_range", "start": 0, "end": 10, "content": "...", "expected": "..."}
    :param title: Optional new title for the note
    :return: JSON with success status and updated note info
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.notes import NoteUpdateForm

        note = await Notes.get_note_by_id(note_id)

        if not note:
            return JSONCodec.dumps({'error': 'Note not found', 'code': 'not_found'})

        user_id = __user__.get('id')
        if __user__.get('role') != 'admin' and not await _has_write_access_to_note(note, user_id):
            return JSONCodec.dumps({'error': 'Write access denied', 'code': 'write_access_denied'})

        current_content = ((note.data or {}).get('content') or {}).get('md') or ''
        applied_operation_count = 0
        if operations is not None:
            try:
                content, applied_operation_count = _apply_note_operations(operations, current_content)
            except _NoteOperationError as e:
                return JSONCodec.dumps(e.payload)
        elif content is None:
            return JSONCodec.dumps({'error': 'content or operations is required', 'code': 'content_required'})

        try:
            await stop_item_tasks(__request__.app.state.redis, f'note:{note_id}')
        except Exception:
            pass

        form = NoteUpdateForm(**_note_update(note, content, title))
        updated_note = await Notes.update_note_by_id(note_id, form)

        if not updated_note:
            return JSONCodec.dumps({'error': 'Failed to update note', 'code': 'update_failed'})

        await _emit_note_updated(__request__, __user__, updated_note)

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': updated_note.id,
                'title': updated_note.title,
                'updated_at': updated_note.updated_at,
                'applied_operation_count': applied_operation_count,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'replace_note_content error: {e}')
        return JSONCodec.dumps({'error': str(e), 'code': 'unexpected_error'})


# =============================================================================
# CHATS TOOLS
# =============================================================================


async def search_chats(
    query: str,
    count: int = 5,
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __chat_id__: str = None,
) -> str:
    """
    Search the user's previous chat conversations by title and message content,
    excluding the current chat. Helpful for finding details from earlier
    conversations when they are not already visible in the current context.
    Exact phrase matches are preferred, and descriptive keyword queries are
    supported.

    :param query: Exact phrase or descriptive keyword query to find matching previous chats
    :param count: Maximum number of results to return (default: 5)
    :param start_timestamp: Only include chats updated after this Unix timestamp (seconds)
    :param end_timestamp: Only include chats updated before this Unix timestamp (seconds)
    :return: JSON with matching chats containing id, title, updated_at, and content snippet
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if count < 1:
        return JSONCodec.dumps([])

    try:
        user_id = __user__.get('id')

        chats = await Chats.get_chats_by_user_id_and_search_text(
            user_id=user_id,
            search_text=query,
            include_archived=False,
            skip=0,
            # One more, for the current chat, which is left out below.
            limit=count + 1,
            # The range is part of the query: filtering newest matches
            # afterwards found nothing in a past range (#181).
            updated_after=start_timestamp or None,
            updated_before=end_timestamp or None,
        )

        results = []
        for chat in chats:
            # Skip the current chat to avoid showing it in search results
            if __chat_id__ and chat.id == __chat_id__:
                continue

            # Find a matching message snippet
            snippet = ''
            messages = (getattr(chat, 'chat', None) or {}).get('history', {}).get('messages', {})
            if not messages:
                messages = (getattr(chat, 'chat', None) or {}).get('messages', {}) or {}
            if isinstance(messages, list):
                messages = {str(idx): message for idx, message in enumerate(messages)}

            lower_query = chat_search_content_query(query)
            needles = list(dict.fromkeys([lower_query, *chat_search_terms(lower_query)])) if lower_query else []

            for needle in needles:
                for msg in messages.values():
                    content = msg.get('content', '') if isinstance(msg, dict) else ''
                    match = find_in_lowered(content, needle) if isinstance(content, str) else None
                    if match:
                        start = max(0, match[0] - 50)
                        end = min(len(content), match[1] + 100)
                        snippet = (
                            ('...' if start > 0 else '') + content[start:end] + ('...' if end < len(content) else '')
                        )
                        break
                if snippet:
                    break

            title = chat.title or ''
            if not snippet and any(needle in title.lower() for needle in needles):
                snippet = f'Title match: {title}'

            results.append(
                {
                    'id': chat.id,
                    'title': chat.title,
                    'snippet': snippet,
                    'updated_at': chat.updated_at,
                }
            )

            if len(results) >= count:
                break

        return JSONCodec.dumps(results, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_chats error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def view_chat(
    chat_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Get the full conversation history of a chat by its ID after a relevant
    previous chat has been identified.

    :param chat_id: The ID of the chat to retrieve
    :return: JSON with the chat's id, title, and messages
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        user_id = __user__.get('id')

        chat = await Chats.get_chat_by_id_and_user_id(chat_id, user_id)

        if not chat:
            return JSONCodec.dumps({'error': 'Chat not found or access denied'})

        # Extract messages from history
        messages = []
        history = chat.chat.get('history', {})
        msg_dict = history.get('messages', {})

        # Build message chain from currentId
        current_id = history.get('currentId')
        visited = set()

        while current_id and current_id not in visited:
            visited.add(current_id)
            msg = msg_dict.get(current_id)
            if msg:
                messages.append(
                    {
                        'role': msg.get('role', ''),
                        'content': msg.get('content', ''),
                    }
                )
            current_id = msg.get('parentId') if msg else None

        # Reverse to get chronological order
        messages.reverse()

        return JSONCodec.dumps(
            {
                'id': chat.id,
                'title': chat.title,
                'messages': messages,
                'updated_at': chat.updated_at,
                'created_at': chat.created_at,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'view_chat error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# SUB-AGENT TOOL
# =============================================================================


async def delegate_task(
    task: str,
    context: str = '',
    file_ids: list[str] | None = None,
    background: bool = False,
    __request__: Request = None,
    __user__: dict = None,
    __metadata__: dict = None,
    __chat_id__: str = None,
    __message_id__: str = None,
) -> str:
    """
    Delegate focused work to a parallel sub-agent using the current model and tools.

    :param task: The specific task for the sub-agent to complete
    :param context: Relevant context, decisions, or file paths for the task
    :param file_ids: Attached file IDs the sub-agent needs. Use this for images or files;
        do not put file IDs only in context.
    :param background: Return immediately and continue this chat when the sub-agent finishes
    :return: Foreground result text, or a JSON dispatch handle for background work
    """
    if __request__ is None:
        return 'Error: request context not available.'
    if getattr(__request__.state, 'internal', False) is True:
        return 'Error: sub-agents cannot delegate recursively.'

    from local_llm.utils.subagents import delegate

    return await delegate(
        task,
        context,
        background,
        file_ids=file_ids,
        request=__request__,
        user_data=__user__ or {},
        metadata=__metadata__ or {},
        parent_chat_id=__chat_id__ or '',
        parent_message_id=__message_id__,
    )


async def timer(
    prompt: str,
    at: str,
    cancel_on: list[Literal['chat.read', 'chat.user_message']] | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __metadata__: dict = None,
    __chat_id__: str = None,
    __message_id__: str = None,
) -> str:
    """
    Set a one-shot timer for this chat.

    :param prompt: The prompt to send back into this chat when the timer fires
    :param at: Relative time like 10s, 5m, 1h, 2d, or a timezone-aware RFC 3339 timestamp
    :param cancel_on: Optional events that cancel the timer before it fires
    :return: JSON status with the scheduled time, or an error string
    """
    if __request__ is None:
        return 'Error: request context not available.'
    if getattr(__request__.state, 'internal', False) is True:
        return 'Error: timers cannot be set from internal chats.'

    from local_llm.utils.timers import create_timer

    return await create_timer(
        prompt=prompt,
        at=at,
        cancel_on=cancel_on,
        request=__request__,
        user_data=__user__ or {},
        metadata=__metadata__ or {},
        parent_chat_id=__chat_id__ or '',
        parent_message_id=__message_id__,
    )


# =============================================================================
# CHANNELS TOOLS
# =============================================================================


async def search_channels(
    query: str,
    count: int = 5,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search channels by name and description to find accessible team spaces.

    :param query: The search query to find matching channels
    :param count: Maximum number of results to return (default: 5)
    :return: JSON with matching channels containing id, name, description, and type
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        user_id = __user__.get('id')

        # Get all channels the user has access to
        all_channels = await Channels.get_channels_by_user_id(user_id)

        # Filter by query
        lower_query = query.lower()
        matching_channels = []

        for channel in all_channels:
            name_match = lower_query in channel.name.lower() if channel.name else False
            desc_match = lower_query in (channel.description or '').lower()

            if name_match or desc_match:
                matching_channels.append(
                    {
                        'id': channel.id,
                        'name': channel.name,
                        'description': channel.description or '',
                        'type': channel.type or 'public',
                    }
                )

            if len(matching_channels) >= count:
                break

        return JSONCodec.dumps(matching_channels, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_channels error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def search_channel_messages(
    query: str,
    count: int = 10,
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search messages in channels the user is a member of, including thread replies.
    Helpful for finding prior team/channel discussion.

    :param query: The search query to find matching messages
    :param count: Maximum number of results to return (default: 10)
    :param start_timestamp: Only include messages created after this Unix timestamp (seconds)
    :param end_timestamp: Only include messages created before this Unix timestamp (seconds)
    :return: JSON with matching messages containing channel info, message content, and thread context
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        user_id = __user__.get('id')

        # Get all channels the user has access to
        user_channels = await Channels.get_channels_by_user_id(user_id)
        channel_ids = [c.id for c in user_channels]
        channel_map = {c.id: c for c in user_channels}

        if not channel_ids:
            return JSONCodec.dumps([])

        # Convert timestamps to nanoseconds (Message.created_at is in nanoseconds)
        start_ts = start_timestamp * 1_000_000_000 if start_timestamp else None
        end_ts = end_timestamp * 1_000_000_000 if end_timestamp else None

        # Search messages using the model method
        matching_messages = await Messages.search_messages_by_channel_ids(
            channel_ids=channel_ids,
            query=query,
            start_timestamp=start_ts,
            end_timestamp=end_ts,
            limit=count,
        )

        results = []
        for msg in matching_messages:
            channel = channel_map.get(msg.channel_id)

            # Extract snippet around the match
            content = msg.content or ''
            match = find_in_lowered(content, query.lower())
            if match:
                start = max(0, match[0] - 50)
                end = min(len(content), match[1] + 100)
                snippet = ('...' if start > 0 else '') + content[start:end] + ('...' if end < len(content) else '')
            else:
                snippet = content[:150] + ('...' if len(content) > 150 else '')

            results.append(
                {
                    'channel_id': msg.channel_id,
                    'channel_name': channel.name if channel else 'Unknown',
                    'message_id': msg.id,
                    'content_snippet': snippet,
                    'is_thread_reply': msg.parent_id is not None,
                    'parent_id': msg.parent_id,
                    'created_at': msg.created_at,
                }
            )

        return JSONCodec.dumps(results, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_channel_messages error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def view_channel_message(
    message_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Get the full content of a channel message by its ID, including thread replies.

    :param message_id: The ID of the message to retrieve
    :return: JSON with the message content, channel info, and thread replies if any
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        user_id = __user__.get('id')

        message = await Messages.get_message_by_id(message_id)

        if not message:
            return JSONCodec.dumps({'error': 'Message not found'})

        # Verify user has access to the channel
        channel = await Channels.get_channel_by_id(message.channel_id)
        if not channel:
            return JSONCodec.dumps({'error': 'Channel not found'})

        # Check if user has access to the channel
        user_channels = await Channels.get_channels_by_user_id(user_id)
        channel_ids = [c.id for c in user_channels]

        if message.channel_id not in channel_ids:
            return JSONCodec.dumps({'error': 'Access denied'})

        # Build response with thread information
        result = {
            'id': message.id,
            'channel_id': message.channel_id,
            'channel_name': channel.name,
            'content': message.content,
            'user_id': message.user_id,
            'is_thread_reply': message.parent_id is not None,
            'parent_id': message.parent_id,
            'reply_count': message.reply_count,
            'created_at': message.created_at,
            'updated_at': message.updated_at,
        }

        # Include user info if available
        if message.user:
            result['user_name'] = message.user.name

        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'view_channel_message error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def view_channel_thread(
    parent_message_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Get all messages in a channel thread, including the parent message and all replies.

    :param parent_message_id: The ID of the parent message that started the thread
    :return: JSON with the parent message and all thread replies in chronological order
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        user_id = __user__.get('id')

        # Get the parent message
        parent_message = await Messages.get_message_by_id(parent_message_id)

        if not parent_message:
            return JSONCodec.dumps({'error': 'Message not found'})

        # Verify user has access to the channel
        channel = await Channels.get_channel_by_id(parent_message.channel_id)
        if not channel:
            return JSONCodec.dumps({'error': 'Channel not found'})

        user_channels = await Channels.get_channels_by_user_id(user_id)
        channel_ids = [c.id for c in user_channels]

        if parent_message.channel_id not in channel_ids:
            return JSONCodec.dumps({'error': 'Access denied'})

        # Get all thread replies
        thread_replies = await Messages.get_thread_replies_by_message_id(parent_message_id)

        # Build the response
        messages = []

        # Add parent message first
        messages.append(
            {
                'id': parent_message.id,
                'content': parent_message.content,
                'user_id': parent_message.user_id,
                'user_name': parent_message.user.name if parent_message.user else None,
                'is_parent': True,
                'created_at': parent_message.created_at,
            }
        )

        # Add thread replies (reverse to get chronological order)
        for reply in reversed(thread_replies):
            messages.append(
                {
                    'id': reply.id,
                    'content': reply.content,
                    'user_id': reply.user_id,
                    'user_name': reply.user.name if reply.user else None,
                    'is_parent': False,
                    'reply_to_id': reply.reply_to_id,
                    'created_at': reply.created_at,
                }
            )

        return JSONCodec.dumps(
            {
                'channel_id': parent_message.channel_id,
                'channel_name': channel.name,
                'thread_id': parent_message_id,
                'message_count': len(messages),
                'messages': messages,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'view_channel_thread error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# KNOWLEDGE BASE TOOLS
# =============================================================================


async def list_knowledge_bases(
    count: int = 10,
    skip: int = 0,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    List the user's accessible knowledge bases so a relevant internal source
    can be chosen.

    :param count: Maximum number of KBs to return (default: 10)
    :param skip: Number of results to skip for pagination (default: 0)
    :return: JSON with KBs containing id, name, description, and file_count
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.knowledge import Knowledges

        user_id = __user__.get('id')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        result = await Knowledges.search_knowledge_bases(
            user_id,
            filter={
                'query': '',
                'user_id': user_id,
                'group_ids': user_group_ids,
            },
            skip=skip,
            limit=count,
        )

        knowledge_bases = []
        for knowledge_base in result.items:
            knowledge_bases.append(
                {
                    'id': knowledge_base.id,
                    'name': knowledge_base.name,
                    'description': knowledge_base.description or '',
                    # Counted by the search itself, without loading each file's text (#186).
                    'file_count': knowledge_base.file_count or 0,
                    'updated_at': knowledge_base.updated_at,
                }
            )

        return JSONCodec.dumps(knowledge_bases, ensure_ascii=False)
    except Exception as e:
        log.exception(f'list_knowledge_bases error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def search_knowledge_bases(
    query: str,
    count: int = 5,
    skip: int = 0,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search the user's accessible knowledge bases by name and description to find
    a relevant internal source.

    :param query: The search query to find matching knowledge bases
    :param count: Maximum number of results to return (default: 5)
    :param skip: Number of results to skip for pagination (default: 0)
    :return: JSON with matching KBs containing id, name, description, and file_count
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.knowledge import Knowledges

        user_id = __user__.get('id')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        result = await Knowledges.search_knowledge_bases(
            user_id,
            filter={
                'query': query,
                'user_id': user_id,
                'group_ids': user_group_ids,
            },
            skip=skip,
            limit=count,
        )

        knowledge_bases = []
        for knowledge_base in result.items:
            knowledge_bases.append(
                {
                    'id': knowledge_base.id,
                    'name': knowledge_base.name,
                    'description': knowledge_base.description or '',
                    # Counted by the search itself, without loading each file's text (#186).
                    'file_count': knowledge_base.file_count or 0,
                    'updated_at': knowledge_base.updated_at,
                }
            )

        return JSONCodec.dumps(knowledge_bases, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_knowledge_bases error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def search_knowledge_files(
    query: str,
    knowledge_id: str | None = None,
    count: int = 5,
    skip: int = 0,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    Search files by filename across knowledge bases the user has access to.
    When the model has attached knowledge, searches only within attached KBs and files.
    Helpful when looking for a specific document or file name.

    :param query: The search query to find matching files by filename
    :param knowledge_id: Optional KB id to limit search to a specific knowledge base
    :param count: Maximum number of results to return (default: 5)
    :param skip: Number of results to skip for pagination (default: 0)
    :return: JSON with matching files containing id, filename, and updated_at
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.access_grants import AccessGrants
        from local_llm.models.files import Files
        from local_llm.models.knowledge import Knowledges

        user_id = __user__.get('id')
        user_role = __user__.get('role', 'user')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        # When model has attached knowledge, scope to attached KBs/files only
        if __model_knowledge__:
            attached_kb_ids = set()
            attached_file_ids = set()

            for item in __model_knowledge__:
                item_type = item.get('type')
                item_id = item.get('id')
                if item_type == 'collection':
                    attached_kb_ids.add(item_id)
                elif item_type == 'file':
                    attached_file_ids.add(item_id)

            # If knowledge_id specified, verify it's in the attached set
            if knowledge_id:
                if knowledge_id not in attached_kb_ids:
                    return JSONCodec.dumps({'error': f'Knowledge base {knowledge_id} is not attached to this model'})
                attached_kb_ids = {knowledge_id}

            all_files = []

            # Search within attached KBs
            for kb_id in attached_kb_ids:
                knowledge = await Knowledges.get_knowledge_by_id(kb_id)
                if not knowledge:
                    continue

                if not (
                    user_role == 'admin'
                    or knowledge.user_id == user_id
                    or await AccessGrants.has_access(
                        user_id=user_id,
                        resource_type='knowledge',
                        resource_id=knowledge.id,
                        permission='read',
                        user_group_ids=set(user_group_ids),
                    )
                    or is_folder_entry(__model_knowledge__, 'collection', knowledge.id)
                ):
                    continue

                result = await Knowledges.search_files_by_id(
                    knowledge_id=kb_id,
                    user_id=user_id,
                    filter={'query': query},
                    skip=0,
                    limit=count + skip,
                )

                for file in result.items:
                    all_files.append(
                        {
                            'id': file.id,
                            'filename': file.filename,
                            'knowledge_id': knowledge.id,
                            'knowledge_name': knowledge.name,
                            'updated_at': file.updated_at,
                        }
                    )

            # Search within directly attached files (filename match)
            if not knowledge_id and attached_file_ids:
                query_lower = query.lower() if query else ''
                for file_id in attached_file_ids:
                    file = await Files.get_file_by_id(file_id)
                    if file and (not query_lower or query_lower in file.filename.lower()):
                        all_files.append(
                            {
                                'id': file.id,
                                'filename': file.filename,
                                'updated_at': file.updated_at,
                            }
                        )

            # Apply pagination across combined results
            all_files = all_files[skip : skip + count]
            return JSONCodec.dumps(all_files, ensure_ascii=False)

        # No attached knowledge - search all accessible KBs
        if knowledge_id:
            # search_files_by_id does not enforce knowledge_id ownership; mirror the attached-KB check above.
            knowledge = await Knowledges.get_knowledge_by_id(knowledge_id)
            if not knowledge or not (
                user_role == 'admin'
                or knowledge.user_id == user_id
                or await AccessGrants.has_access(
                    user_id=user_id,
                    resource_type='knowledge',
                    resource_id=knowledge.id,
                    permission='read',
                    user_group_ids=set(user_group_ids),
                )
            ):
                return JSONCodec.dumps({'error': f'Access denied to knowledge base {knowledge_id}'})

            result = await Knowledges.search_files_by_id(
                knowledge_id=knowledge_id,
                user_id=user_id,
                filter={'query': query},
                skip=skip,
                limit=count,
            )
        else:
            result = await Knowledges.search_knowledge_files(
                filter={
                    'query': query,
                    'user_id': user_id,
                    'group_ids': user_group_ids,
                },
                skip=skip,
                limit=count,
            )

        files = []
        for file in result.items:
            file_info = {
                'id': file.id,
                'filename': file.filename,
                'updated_at': file.updated_at,
            }
            if hasattr(file, 'collection') and file.collection:
                file_info['knowledge_id'] = file.collection.get('id', '')
                file_info['knowledge_name'] = file.collection.get('name', '')
            files.append(file_info)

        return JSONCodec.dumps(files, ensure_ascii=False)
    except Exception as e:
        log.exception(f'search_knowledge_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def _get_accessible_chat_files(
    files: list[dict] | None,
    user: dict,
    file_id: str | None = None,
) -> list[tuple[dict, object]]:
    from local_llm.models.files import Files

    accessible = []
    seen = set()

    for item in files or []:
        if not isinstance(item, dict) or item.get('type', 'file') != 'file':
            continue
        fid = item.get('id') or item.get('url') or ''
        if (
            not isinstance(fid, str)
            or not fid
            or fid in seen
            or fid.startswith(('http://', 'https://', 'data:'))
            or (file_id and fid != file_id)
        ):
            continue
        normalized = {**item, 'id': fid, 'type': 'file'}
        if 'name' not in normalized and item.get('filename'):
            normalized['name'] = item.get('filename')
        seen.add(fid)

        file = await Files.get_file_by_id(fid)
        if file and await _has_read_access_to_file(file, user):
            accessible.append((normalized, file))

    return accessible


def _grep_file_models(
    files_to_search: list,
    pattern: str,
    case_insensitive: bool = False,
    count_only: bool = False,
) -> str:
    from local_llm.tools.knowledge_fs import build_matcher

    matches, err = build_matcher(pattern, case_insensitive)
    if err:
        return JSONCodec.dumps({'error': err})

    results = []
    total_matches = 0
    counts = []

    for file in files_to_search:
        content = ''
        if file.data:
            content = file.data.get('content', '')
        if not content:
            continue

        lines = split_lines(content)
        file_matches = 0

        for i, line in enumerate(lines, 1):
            if matches(line):
                file_matches += 1
                total_matches += 1
                if not count_only and len(results) < KNOWLEDGE_GREP_MAX_MATCHES:
                    results.append(f'{file.id}  {file.filename}:{i}: {line}')

        if file_matches > 0 and count_only:
            counts.append(f'{file.id}  {file.filename}: {file_matches}')

    if count_only:
        if not counts:
            return f'No matches for "{pattern}"'
        return '\n'.join(counts) + f'\n[{total_matches} total matches]'

    if not results:
        return f'No matches for "{pattern}"'

    output = '\n'.join(results)
    if total_matches > KNOWLEDGE_GREP_MAX_MATCHES:
        output += f'\n[{KNOWLEDGE_GREP_MAX_MATCHES} of {total_matches} matches shown — use file_id to narrow]'
    return output


async def list_chat_files(
    __request__: Request = None,
    __user__: dict = None,
    __files__: list[dict] = None,
) -> str:
    """
    List files attached to the current chat.

    :return: JSON with attached chat files containing id, filename, content type, size, and updated time when available
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        files = []
        for item, file in await _get_accessible_chat_files(__files__, __user__):
            file_info = {
                'id': file.id,
                'filename': file.filename,
                'name': item.get('name') or file.filename,
                'type': item.get('type', 'file'),
                'updated_at': file.updated_at,
            }
            content_type = item.get('content_type') or (file.meta or {}).get('content_type')
            size = item.get('size') or (file.meta or {}).get('size')
            if content_type:
                file_info['content_type'] = content_type
            if size:
                file_info['size'] = size
            files.append(file_info)

        return JSONCodec.dumps(files, ensure_ascii=False)
    except Exception as e:
        log.exception(f'list_chat_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def grep_chat_files(
    pattern: str,
    file_id: str | None = None,
    case_insensitive: bool = False,
    count_only: bool = False,
    __request__: Request = None,
    __user__: dict = None,
    __files__: list[dict] = None,
) -> str:
    """
    Search exact text across files attached to the current chat.
    Pass file_id from the attached_files block to search one file.

    :param pattern: The text pattern to search for
    :param file_id: Optional attached file ID to search within a single file
    :param case_insensitive: If true, ignore case when matching
    :param count_only: If true, return only match counts per file
    :return: Matching lines with file IDs, filenames, and line numbers
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if not pattern or not pattern.strip():
        return JSONCodec.dumps({'error': 'Pattern is required'})

    if isinstance(file_id, str) and file_id.lower() in ('none', 'null', ''):
        file_id = None

    try:
        attached_ids = set()
        for item in __files__ or []:
            if not isinstance(item, dict) or item.get('type', 'file') != 'file':
                continue
            fid = item.get('id') or item.get('url')
            if isinstance(fid, str) and fid and not fid.startswith(('http://', 'https://', 'data:')):
                attached_ids.add(fid)

        if not attached_ids:
            return JSONCodec.dumps({'error': 'No files are attached to this chat'})
        if file_id and file_id not in attached_ids:
            return JSONCodec.dumps({'error': 'File not found'})

        files_to_search = [file for _, file in await _get_accessible_chat_files(__files__, __user__, file_id)]
        if not files_to_search:
            return JSONCodec.dumps({'error': 'No accessible files found'})

        return _grep_file_models(files_to_search, pattern, case_insensitive, count_only)
    except Exception as e:
        log.exception(f'grep_chat_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def query_chat_files(
    query: str,
    file_id: str | None = None,
    count: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __files__: list[dict] = None,
) -> str:
    """
    Search files attached to the current chat using semantic/vector search.
    Pass file_id from the attached_files block to search one file, or omit it to search all attached chat files.

    :param query: The search query to find semantically relevant content
    :param file_id: Optional attached file ID to search within a single file
    :param count: Maximum number of results to return, capped by the server RAG top k
    :return: JSON with relevant chunks containing content, source filename, and relevance score
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if isinstance(file_id, str) and file_id.lower() in ('none', 'null', ''):
        file_id = None
    if isinstance(count, str):
        if count.lower() in ('none', 'null', ''):
            count = None
        else:
            try:
                count = int(count)
            except ValueError:
                count = None

    try:
        from local_llm.retrieval.utils import get_sources_from_items

        attached_ids = set()
        for item in __files__ or []:
            if not isinstance(item, dict) or item.get('type', 'file') != 'file':
                continue
            fid = item.get('id') or item.get('url')
            if isinstance(fid, str) and fid and not fid.startswith(('http://', 'https://', 'data:')):
                attached_ids.add(fid)

        if not attached_ids:
            return JSONCodec.dumps({'error': 'No files are attached to this chat'})
        if file_id and file_id not in attached_ids:
            return JSONCodec.dumps({'error': 'File not found'})

        accessible = await _get_accessible_chat_files(__files__, __user__, file_id)
        if not accessible:
            return JSONCodec.dumps({'error': 'No accessible files found'})

        file_items = [{**item} for item, _ in accessible]
        rag_config = await Config.get_many(
            'rag.top_k',
            'rag.top_k_reranker',
            'rag.relevance_threshold',
            'rag.hybrid_bm25_weight',
            'rag.enable_hybrid_search',
            'rag.full_context',
        )
        top_k = rag_config.get('rag.top_k') or 5
        count = top_k if count is None else max(1, min(count, top_k))
        full_context = all(item.get('context') == 'full' for item in file_items) or rag_config.get('rag.full_context')

        embedding_function = getattr(__request__.app.state, 'EMBEDDING_FUNCTION', None)
        if not embedding_function and not full_context:
            return JSONCodec.dumps({'error': 'Embedding function not configured'})

        user_model = UserModel(**__user__)
        sources = await get_sources_from_items(
            request=__request__,
            items=file_items,
            queries=[query],
            embedding_function=(
                lambda queries, prefix: (
                    embedding_function(queries, prefix=prefix, user=user_model) if embedding_function else None
                )
            ),
            k=count,
            reranking_function=(
                (lambda q, docs: __request__.app.state.RERANKING_FUNCTION(q, docs, user=user_model))
                if getattr(__request__.app.state, 'RERANKING_FUNCTION', None)
                else None
            ),
            k_reranker=rag_config.get('rag.top_k_reranker'),
            r=rag_config.get('rag.relevance_threshold'),
            hybrid_bm25_weight=rag_config.get('rag.hybrid_bm25_weight'),
            hybrid_search=rag_config.get('rag.enable_hybrid_search'),
            full_context=full_context,
            user=user_model,
        )

        chunks = []
        pinned = set()  # ids of chunks from a file attached in full
        ranked = []  # each searched file's hits, best first
        scales = set()  # what scored each searched file: None, or the search it fell back to
        for source in sources or []:
            documents = source.get('document') or []
            metadatas = source.get('metadata') or []
            distances = source.get('distances') or []
            source_info = source.get('source') or {}
            whole_file = source_info.get('context') == 'full'

            hits = []
            for idx, doc in enumerate(documents):
                metadata = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {}
                chunk = {
                    'content': doc,
                    'source': metadata.get('source', metadata.get('name', source_info.get('name', 'Unknown'))),
                    'file_id': metadata.get('file_id', source_info.get('id', '')),
                }
                if idx < len(distances):
                    chunk['distance'] = distances[idx]
                if whole_file:
                    pinned.add(id(chunk))
                else:
                    hits.append(chunk)
                chunks.append(chunk)
            if hits:
                ranked.append(hits)
                scales.add(source.get('fallback'))

        # Each file was searched on its own and comes back in attachment
        # order, so rank every file's hits together before keeping `count`
        # (higher scores are better, as everywhere in retrieval) (#177). A
        # file attached in full is a whole document, not a hit: it goes
        # first, in attachment order, as it did before. The sort is stable.
        # A file whose search fell back (hybrid to vector, or a failed
        # reranker to embedding similarity) scored on another scale, so then
        # the files take turns by rank instead, as knowledge files do (#477,
        # #503).
        if not full_context and len(scales) > 1:
            chunks = [c for c in chunks if id(c) in pinned] + _take_turns(ranked)
        elif not full_context:
            chunks.sort(
                key=lambda c: (id(c) in pinned, c.get('distance') is not None, c.get('distance') or 0.0),
                reverse=True,
            )
        return JSONCodec.dumps(chunks[:count], ensure_ascii=False)
    except Exception as e:
        log.exception(f'query_chat_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def grep_knowledge_files(
    pattern: str,
    file_id: str | None = None,
    case_insensitive: bool = False,
    count_only: bool = False,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    Search for exact text across knowledge files. Returns matching lines with line numbers.
    Unlike query_knowledge_files (semantic/vector search), this performs exact string matching.
    Automatically detects regex patterns (e.g. "error|warn", "version \\d+").
    Helpful for literal strings, identifiers, error messages, or regex-style searches.

    :param pattern: The text pattern to search for (regex auto-detected)
    :param file_id: Optional file ID to search within a single file only
    :param case_insensitive: If true, ignore case when matching (default: false)
    :param count_only: If true, return only match counts per file (default: false)
    :return: Matching lines with file IDs, filenames, and line numbers
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if not pattern or not pattern.strip():
        return JSONCodec.dumps({'error': 'Pattern is required'})

    try:
        from local_llm.models.files import Files
        from local_llm.models.knowledge import Knowledges

        user_id = __user__.get('id')
        user_role = __user__.get('role', 'user')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        # Collect files to search
        files_to_search = []

        if file_id:
            # Single file mode — verify access
            file = await Files.get_file_by_id(file_id)
            if file:
                if not await _has_read_access_to_file(file, __user__, __model_knowledge__):
                    return JSONCodec.dumps({'error': 'File not found'})
                files_to_search.append(file)
        elif __model_knowledge__:
            # Scoped to model's attached knowledge
            from local_llm.models.access_grants import AccessGrants

            seen_ids = set()
            for item in __model_knowledge__:
                item_type = item.get('type')
                item_id = item.get('id')
                if item_type == 'file' and item_id not in seen_ids:
                    file = await Files.get_file_by_id(item_id)
                    if file:
                        files_to_search.append(file)
                        seen_ids.add(item_id)
                elif item_type == 'collection':
                    knowledge = await Knowledges.get_knowledge_by_id(item_id)
                    if not knowledge:
                        continue
                    # Verify user can access this KB
                    if not (
                        user_role == 'admin'
                        or knowledge.user_id == user_id
                        or await AccessGrants.has_access(
                            user_id=user_id,
                            resource_type='knowledge',
                            resource_id=knowledge.id,
                            permission='read',
                            user_group_ids=set(user_group_ids),
                        )
                        or is_folder_entry(__model_knowledge__, 'collection', knowledge.id)
                    ):
                        continue
                    kb_files = await Knowledges.get_files_by_id(item_id)
                    if kb_files:
                        for f in kb_files:
                            if f.id not in seen_ids:
                                files_to_search.append(f)
                                seen_ids.add(f.id)
        else:
            # All accessible knowledge bases — use the same search pattern as list_knowledge_bases
            result = await Knowledges.search_knowledge_bases(
                user_id,
                filter={
                    'query': '',
                    'user_id': user_id,
                    'group_ids': user_group_ids,
                },
                skip=0,
                limit=200,
            )
            seen_ids = set()
            for kb in result.items:
                file_ids = []
                # Get files attached to this KB
                files_from_kb = await Knowledges.get_files_by_id(kb.id)
                if files_from_kb:
                    file_ids = [f.id for f in files_from_kb]
                for fid in file_ids:
                    if fid not in seen_ids:
                        file = await Files.get_file_by_id(fid)
                        if file:
                            files_to_search.append(file)
                            seen_ids.add(fid)

        if not files_to_search:
            return JSONCodec.dumps({'error': 'No accessible files found'})

        return _grep_file_models(files_to_search, pattern, case_insensitive, count_only)

    except Exception as e:
        log.exception(f'grep_knowledge_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


def _line_arg(value, name: str) -> int | None:
    """A start_line / end_line from a tool call, which may come as text; None when unset. Raises ValueError."""
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        pass
    elif isinstance(value, int):
        return value
    else:
        try:
            number = float(value)  # '5.0' and 2.0 read as 5 and 2; '1.5', 'x' and 'nan' do not
        except (TypeError, ValueError):
            number = None
        if number is not None and number.is_integer():
            return int(number)
    raise ValueError(f'{name} must be a whole number, got {value!r}')


def _lines_page(content: str, start_line: int, end_line: int | None) -> dict:
    """Lines start_line..end_line (1-indexed, inclusive; 100 when end_line is unset or 0), numbered, as view_file does.

    Lines are split on '\\n' only, and a final newline ends the last line
    rather than starting another (#666). A range that selects nothing (it starts past the end, or ends before it
    starts) says so in `note`, instead of a reversed `showing_lines` (#513).
    """
    all_lines = split_lines(content)
    total_lines = len(all_lines)
    s = max(1, start_line) - 1  # 1-indexed to 0-indexed
    e = min(total_lines, end_line if end_line else s + 100)
    if e <= s:
        why = 'start_line is past the end of the file' if s >= total_lines else 'end_line is before start_line'
        return {'content': '', 'total_lines': total_lines, 'note': f'No lines: {why}.'}
    page = {
        'content': '\n'.join(f'{s + i + 1}: {line}' for i, line in enumerate(all_lines[s:e])),
        'total_lines': total_lines,
        'showing_lines': f'{s + 1}-{e}',
    }
    if e < total_lines:
        page['truncated'] = True
        page['next_start_line'] = e + 1
    return page


def _number_page(content: str, offset: int, sliced: str) -> tuple[str, bool]:
    """A character page of `content` with each line numbered, and whether its first line began on an earlier page.

    A page that ends on a newline gives the empty rest after it no number:
    that number is the next page's first line, which showed it twice (#513).
    """
    if not sliced:
        return '', False
    start_ln = content[:offset].count('\n') + 1
    lines = sliced.split('\n')
    numbered = [f'{start_ln + i}: {line}' for i, line in enumerate(lines)]
    if len(lines) > 1 and lines[-1] == '':
        numbered[-1] = ''
    return '\n'.join(numbered), 0 < offset <= len(content) and content[offset - 1] != '\n'


async def view_file(
    file_id: str,
    offset: int = 0,
    max_chars: int = VIEW_FILE_DEFAULT_MAX_CHARS,
    line_numbers: bool = False,
    start_line: int | None = None,
    end_line: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    Get the content of a file by its ID. Supports pagination for large files.

    :param file_id: The ID of the file to retrieve
    :param offset: Character offset to start reading from (default: 0)
    :param max_chars: Maximum characters to return (a server-side hard cap applies)
    :param line_numbers: If true, prefix each line with its 1-indexed line number
    :param start_line: Optional 1-indexed start line (overrides offset/max_chars when set; 0 reads as 1)
    :param end_line: Optional 1-indexed end line (inclusive; unset or 0 means 100 lines from start_line)
    :return: JSON with the file's id, filename, content, and pagination metadata if truncated;
        with line_numbers, first_line_continued is true when the page starts mid-line; a line range
        that selects nothing returns empty content and a note saying why
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    # Coerce parameters from LLM tool calls (may come as strings)
    if isinstance(offset, str):
        try:
            offset = int(offset)
        except ValueError:
            offset = 0
    if isinstance(max_chars, str):
        try:
            max_chars = int(max_chars)
        except ValueError:
            max_chars = VIEW_FILE_DEFAULT_MAX_CHARS

    try:
        start_line = _line_arg(start_line, 'start_line')
        end_line = _line_arg(end_line, 'end_line')
    except ValueError as e:
        return JSONCodec.dumps({'error': str(e)})

    # Enforce hard cap
    max_chars = min(max(max_chars, 1), VIEW_FILE_MAX_CHARS)
    offset = max(offset, 0)

    try:
        from local_llm.models.files import Files

        file = await Files.get_file_by_id(file_id)
        if not file:
            return JSONCodec.dumps({'error': 'File not found'})

        if not await _has_read_access_to_file(file, __user__, __model_knowledge__):
            return JSONCodec.dumps({'error': 'File not found'})

        content = ''
        if file.data:
            content = file.data.get('content', '')

        total_chars = len(content)

        # Line-based addressing (overrides char-based offset/max_chars)
        if start_line is not None:
            page = _lines_page(content, start_line, end_line)
            result = {
                'id': file.id,
                'filename': file.filename,
                'content': page.pop('content'),
                'updated_at': file.updated_at,
                'created_at': file.created_at,
                **page,
            }
            return JSONCodec.dumps(result, ensure_ascii=False)

        sliced = content[offset : offset + max_chars]
        # Measured before line numbers are added: the "12: " prefixes once
        # pushed next_offset past text never returned (#178).
        returned = len(sliced)
        is_truncated = (offset + returned) < total_chars

        continued = False
        if line_numbers:
            sliced, continued = _number_page(content, offset, sliced)

        result = {
            'id': file.id,
            'filename': file.filename,
            'content': sliced,
            'updated_at': file.updated_at,
            'created_at': file.created_at,
        }
        if continued:
            result['first_line_continued'] = True

        if is_truncated or offset > 0:
            result['truncated'] = is_truncated
            result['total_chars'] = total_chars
            result['returned_chars'] = returned
            result['offset'] = offset
            if is_truncated:
                result['next_offset'] = offset + returned

        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'view_file error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def view_knowledge_file(
    file_id: str,
    offset: int = 0,
    max_chars: int = VIEW_FILE_DEFAULT_MAX_CHARS,
    line_numbers: bool = False,
    start_line: int | None = None,
    end_line: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    Get the content of a file from a knowledge base. Supports pagination for large files.

    :param file_id: The ID of the file to retrieve
    :param offset: Character offset to start reading from (default: 0)
    :param max_chars: Maximum characters to return (a server-side hard cap applies)
    :param line_numbers: If true, prefix each line with its 1-indexed line number
    :param start_line: Optional 1-indexed start line (overrides offset/max_chars when set; 0 reads as 1)
    :param end_line: Optional 1-indexed end line (inclusive; unset or 0 means 100 lines from start_line)
    :return: JSON with the file's id, filename, content, and pagination metadata if truncated;
        with line_numbers, first_line_continued is true when the page starts mid-line; a line range
        that selects nothing returns empty content and a note saying why
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    # Coerce parameters from LLM tool calls (may come as strings)
    if isinstance(offset, str):
        try:
            offset = int(offset)
        except ValueError:
            offset = 0
    if isinstance(max_chars, str):
        try:
            max_chars = int(max_chars)
        except ValueError:
            max_chars = VIEW_FILE_DEFAULT_MAX_CHARS

    try:
        start_line = _line_arg(start_line, 'start_line')
        end_line = _line_arg(end_line, 'end_line')
    except ValueError as e:
        return JSONCodec.dumps({'error': str(e)})

    # Enforce hard cap
    max_chars = min(max(max_chars, 1), VIEW_FILE_MAX_CHARS)
    offset = max(offset, 0)

    try:
        from local_llm.models.access_grants import AccessGrants
        from local_llm.models.files import Files
        from local_llm.models.knowledge import Knowledges

        user_id = __user__.get('id')
        user_role = __user__.get('role', 'user')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        file = await Files.get_file_by_id(file_id)
        if not file:
            return JSONCodec.dumps({'error': 'File not found'})

        # Check access via any KB containing this file
        knowledges = await Knowledges.get_knowledges_by_file_id(file_id)
        has_knowledge_access = False
        knowledge_info = None

        for knowledge_base in knowledges:
            if (
                user_role == 'admin'
                or knowledge_base.user_id == user_id
                or await AccessGrants.has_access(
                    user_id=user_id,
                    resource_type='knowledge',
                    resource_id=knowledge_base.id,
                    permission='read',
                    user_group_ids=set(user_group_ids),
                )
                or is_folder_entry(__model_knowledge__, 'collection', knowledge_base.id)
            ):
                has_knowledge_access = True
                knowledge_info = {'id': knowledge_base.id, 'name': knowledge_base.name}
                break

        if not has_knowledge_access:
            if file.user_id != user_id and user_role != 'admin':
                return JSONCodec.dumps({'error': 'Access denied'})

        content = ''
        if file.data:
            content = file.data.get('content', '')

        total_chars = len(content)

        # Line-based addressing (overrides char-based offset/max_chars)
        if start_line is not None:
            page = _lines_page(content, start_line, end_line)
            result = {
                'id': file.id,
                'filename': file.filename,
                'content': page.pop('content'),
                'updated_at': file.updated_at,
                'created_at': file.created_at,
                **page,
            }
            if knowledge_info:
                result['knowledge_id'] = knowledge_info['id']
                result['knowledge_name'] = knowledge_info['name']
            return JSONCodec.dumps(result, ensure_ascii=False)

        sliced = content[offset : offset + max_chars]
        # Measured before line numbers are added: the "12: " prefixes once
        # pushed next_offset past text never returned (#178).
        returned = len(sliced)
        is_truncated = (offset + returned) < total_chars

        continued = False
        if line_numbers:
            sliced, continued = _number_page(content, offset, sliced)

        result = {
            'id': file.id,
            'filename': file.filename,
            'content': sliced,
            'updated_at': file.updated_at,
            'created_at': file.created_at,
        }
        if continued:
            result['first_line_continued'] = True
        if knowledge_info:
            result['knowledge_id'] = knowledge_info['id']
            result['knowledge_name'] = knowledge_info['name']

        if is_truncated or offset > 0:
            result['truncated'] = is_truncated
            result['total_chars'] = total_chars
            result['returned_chars'] = returned
            result['offset'] = offset
            if is_truncated:
                result['next_offset'] = offset + returned

        return JSONCodec.dumps(result, ensure_ascii=False)
    except Exception as e:
        log.exception(f'view_knowledge_file error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def list_knowledge(
    knowledge_id: str | None = None,
    skip: int = 0,
    count: int = 50,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] | None = None,
) -> str:
    """
    List knowledge bases, files, and notes attached to the current model.
    Use this first to discover what knowledge is available before querying or reading files.
    Without knowledge_id: returns KB summaries (name, description, file_count)
    plus standalone files and notes — no file listing inside KBs.
    With knowledge_id: includes paginated file listing for that specific KB.
    Use skip/count to page through large KBs.

    :param knowledge_id: Optional KB ID to get file listing for
    :param skip: Number of files to skip for pagination (default: 0)
    :param count: Maximum files per page (default: 50, max: 200)
    :return: JSON with knowledge_bases, files, and notes attached to this model
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    if not __model_knowledge__:
        return JSONCodec.dumps({'knowledge_bases': [], 'files': [], 'notes': []})

    # Coerce parameters from LLM tool calls (may come as strings)
    if isinstance(skip, str):
        try:
            skip = int(skip)
        except ValueError:
            skip = 0
    if isinstance(count, str):
        try:
            count = int(count)
        except ValueError:
            count = 50
    if isinstance(knowledge_id, str) and knowledge_id.lower() in ('none', 'null', ''):
        knowledge_id = None

    count = max(min(count, 200), 0)
    skip = max(skip, 0)

    try:
        from local_llm.models.access_grants import AccessGrants
        from local_llm.models.files import Files
        from local_llm.models.knowledge import Knowledges
        from local_llm.models.notes import Notes

        user_id = __user__.get('id')
        user_role = __user__.get('role', 'user')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]

        knowledge_bases = []
        files = []
        notes = []

        for item in __model_knowledge__:
            item_type = item.get('type')
            item_id = item.get('id')

            if item_type == 'collection':
                knowledge = await Knowledges.get_knowledge_by_id(item_id)
                if knowledge and (
                    user_role == 'admin'
                    or knowledge.user_id == user_id
                    or await AccessGrants.has_access(
                        user_id=user_id,
                        resource_type='knowledge',
                        resource_id=knowledge.id,
                        permission='read',
                        user_group_ids=set(user_group_ids),
                    )
                    or is_folder_entry(__model_knowledge__, 'collection', knowledge.id)
                ):
                    # Counted, and for the targeted base paged, without loading
                    # each file's text, and in a stable order (#186).
                    targeted = bool(knowledge_id and knowledge_id == knowledge.id)
                    file_count, paged_files = await Knowledges.get_file_page_by_id(
                        knowledge.id, skip=skip, limit=count if targeted else 0
                    )

                    kb_entry = {
                        'id': knowledge.id,
                        'name': knowledge.name,
                        'description': knowledge.description or '',
                        'file_count': file_count,
                    }

                    # Include file listing only when this KB is targeted
                    if targeted:
                        if file_count:
                            kb_entry['files'] = [{'id': fid, 'filename': name} for fid, name in paged_files]
                            kb_entry['files_skip'] = skip
                            kb_entry['files_count'] = len(paged_files)
                            kb_entry['files_total'] = file_count
                            kb_entry['has_more'] = skip + count < file_count

                    knowledge_bases.append(kb_entry)

            elif item_type == 'file':
                file = await Files.get_file_by_id(item_id)
                if file:
                    files.append(
                        {
                            'id': file.id,
                            'filename': file.filename,
                            'updated_at': file.updated_at,
                        }
                    )

            elif item_type == 'note':
                note = await Notes.get_note_by_id(item_id)
                if note and (
                    user_role == 'admin'
                    or note.user_id == user_id
                    or await AccessGrants.has_access(
                        user_id=user_id,
                        resource_type='note',
                        resource_id=note.id,
                        permission='read',
                    )
                    or is_folder_entry(__model_knowledge__, 'note', note.id)
                ):
                    notes.append(
                        {
                            'id': note.id,
                            'title': note.title,
                        }
                    )

        return JSONCodec.dumps(
            {
                'knowledge_bases': knowledge_bases,
                'files': files,
                'notes': notes,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'list_knowledge error: {e}')
        return JSONCodec.dumps({'error': str(e)})


def _coerce_count(count):
    # LLM tool calls may pass numbers as strings.
    if isinstance(count, str):
        try:
            return int(count)
        except ValueError:
            return 5
    return count


def _coerce_knowledge_ids(knowledge_ids):
    """Accept "None", "null", "", a JSON array as a string, or a bare id, as LLM tool calls send them."""
    if not isinstance(knowledge_ids, str):
        return knowledge_ids
    if knowledge_ids.lower() in ('none', 'null', ''):
        return None
    try:
        return JSONCodec.loads(knowledge_ids)
    except JSONCodec.JSONDecodeError:
        return [knowledge_ids]


class _KnowledgeSearch:
    """What a knowledge search covers for one user: vector collections, external knowledge bases and notes."""

    def __init__(self, user: dict, group_ids: list[str]):
        self.user_id = user.get('id')
        self.user_role = user.get('role', 'user')
        self.group_ids = group_ids
        self.collection_names = []
        self.external_knowledges = []
        self.note_results = []  # Notes aren't vectorized, so their full content is returned
        self.model_knowledge = []  # Entries from the chat's folder among them count as readable (#755)

    async def can_read_knowledge(self, knowledge) -> bool:
        from local_llm.models.access_grants import AccessGrants

        return (
            self.user_role == 'admin'
            or knowledge.user_id == self.user_id
            or await AccessGrants.has_access(
                user_id=self.user_id,
                resource_type='knowledge',
                resource_id=knowledge.id,
                permission='read',
                user_group_ids=set(self.group_ids),
            )
            or is_folder_entry(self.model_knowledge, 'collection', knowledge.id)
        )

    async def can_read_note(self, note) -> bool:
        from local_llm.models.access_grants import AccessGrants

        return (
            self.user_role == 'admin'
            or note.user_id == self.user_id
            or await AccessGrants.has_access(
                user_id=self.user_id,
                resource_type='note',
                resource_id=note.id,
                permission='read',
            )
            or is_folder_entry(self.model_knowledge, 'note', note.id)
        )

    def add_knowledge(self, knowledge, collection_name: str) -> None:
        if (knowledge.meta or {}).get('source') == 'external':
            self.external_knowledges.append(knowledge)
        else:
            self.collection_names.append(collection_name)

    async def add_readable_knowledge(self, knowledge_id: str) -> None:
        from local_llm.models.knowledge import Knowledges

        knowledge = await Knowledges.get_knowledge_by_id(knowledge_id)
        if knowledge and await self.can_read_knowledge(knowledge):
            self.add_knowledge(knowledge, knowledge_id)

    async def add_model_file(self, file_id: str) -> None:
        from local_llm.models.files import Files

        # A file attached to the model is readable through it (see _has_read_access_to_file).
        if await Files.get_file_by_id(file_id):
            self.collection_names.append(f'file-{file_id}')

    async def add_model_note(self, note_id: str) -> None:
        from local_llm.models.notes import Notes

        note = await Notes.get_note_by_id(note_id)
        if note and await self.can_read_note(note):
            self.note_results.append(
                {
                    'content': note.data.get('content', {}).get('md', ''),
                    'source': note.title,
                    'note_id': note.id,
                    'type': 'note',
                }
            )

    async def add_model_knowledge(self, items: list[dict]) -> None:
        self.model_knowledge = items
        for item in items:
            item_type = item.get('type')
            item_id = item.get('id')
            if item_type == 'collection':
                await self.add_readable_knowledge(item_id)
            elif item_type == 'file':
                await self.add_model_file(item_id)
            elif item_type == 'note':
                await self.add_model_note(item_id)

    async def add_all_accessible(self) -> None:
        from local_llm.models.knowledge import Knowledges

        result = await Knowledges.search_knowledge_bases(
            self.user_id,
            filter={
                'query': '',
                'user_id': self.user_id,
                'group_ids': self.group_ids,
            },
            skip=0,
            limit=50,
        )
        for knowledge_base in result.items:
            self.add_knowledge(knowledge_base, knowledge_base.id)


def _first_query_hits(query_results: dict) -> tuple[list, list, list]:
    return tuple(query_results.get(key, [[]])[0] for key in ('documents', 'metadatas', 'distances'))


def _hit_metadata(metadatas: list, idx: int) -> dict:
    # A hit may have no metadata entry, or a null one (vmetadata is nullable).
    return (metadatas[idx] if idx < len(metadatas) else None) or {}


def _with_distance(chunk_info: dict, idx: int, distances: list) -> dict:
    if idx < len(distances):
        chunk_info['distance'] = distances[idx]
    return chunk_info


def _vector_chunks(query_results) -> list[dict]:
    if not (query_results and 'documents' in query_results):
        return []
    documents, metadatas, distances = _first_query_hits(query_results)
    chunks = []
    for idx, doc in enumerate(documents):
        metadata = _hit_metadata(metadatas, idx)
        chunk_info = {
            'content': doc,
            'source': metadata.get('source', metadata.get('name', 'Unknown')),
            'file_id': metadata.get('file_id', ''),
        }
        chunks.append(_with_distance(chunk_info, idx, distances))
    return chunks


def _external_chunks(query_results: dict, knowledge) -> list[dict]:
    documents, metadatas, distances = _first_query_hits(query_results)
    chunks = []
    for idx, doc in enumerate(documents):
        metadata = _hit_metadata(metadatas, idx)
        chunk_info = {
            'content': doc,
            'source': metadata.get('source', metadata.get('name', knowledge.name)),
            'file_id': metadata.get('file_id', f'external-{knowledge.id}'),
            'type': 'external',
            'knowledge_id': knowledge.id,
        }
        chunks.append(_with_distance(chunk_info, idx, distances))
    return chunks


def _take_turns(sources: list[list[dict]]) -> list[dict]:
    """Every source's hits, best first, taking turns: first hits, then second, ...

    Merged by each source's own rank, not by score: an internal hit's
    `distance` is a similarity (higher is better), as is an external
    pgvector base's (#350), but Qdrant and Milvus bases report whatever
    their collection's metric gives (#179).
    """
    merged = []
    for rank in range(max((len(hits) for hits in sources), default=0)):
        merged.extend(hits[rank] for hits in sources if rank < len(hits))
    return merged


async def query_knowledge_files(
    query: str,
    knowledge_ids: list[str] | None = None,
    count: int = 5,
    __request__: Request = None,
    __user__: dict = None,
    __model_knowledge__: list[dict] = None,
) -> str:
    """
    Search knowledge base files using semantic/vector search. Searches across collections (KBs),
    individual files, and notes that the user has access to.
    Helpful for internal documentation, uploaded knowledge, and attached model knowledge.

    :param query: The search query to find semantically relevant content
    :param knowledge_ids: Optional list of KB ids to limit search to specific knowledge bases
    :param count: Maximum number of search hits to return (default: 5); attached notes, up to as many again, come first
    :return: JSON with relevant chunks containing content, source filename, and relevance score
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    count = _coerce_count(count)
    knowledge_ids = _coerce_knowledge_ids(knowledge_ids)

    try:
        from local_llm.retrieval.external import retrieve_external_knowledge
        from local_llm.retrieval.utils import query_collection

        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(__user__.get('id'))]

        embedding_function = getattr(__request__.app.state, 'EMBEDDING_FUNCTION', None)
        if not embedding_function:
            return JSONCodec.dumps({'error': 'Embedding function not configured'})
        user_model = UserModel(**__user__)

        # Model knowledge takes precedence over given ids; with neither, every accessible KB is searched.
        search = _KnowledgeSearch(__user__, user_group_ids)
        if __model_knowledge__:
            await search.add_model_knowledge(__model_knowledge__)
        elif knowledge_ids:
            for knowledge_id in knowledge_ids:
                await search.add_readable_knowledge(knowledge_id)
        else:
            await search.add_all_accessible()

        # Attached notes have their own budget, so they cannot use up the
        # hits (#179).
        notes = list(search.note_results)[:count]
        sources = []

        if search.collection_names:
            query_results = await query_collection(
                __request__,
                collection_names=search.collection_names,
                queries=[query],
                embedding_function=lambda queries, prefix: embedding_function(queries, prefix=prefix, user=user_model),
                k=count,
            )
            sources.append(_vector_chunks(query_results))

        failed = []
        for knowledge in search.external_knowledges:
            # One base that is down or misconfigured must not lose every
            # other result (#180).
            try:
                query_results = await retrieve_external_knowledge(
                    __request__,
                    knowledge,
                    queries=[query],
                    count=count,
                    user=user_model,
                )
            except Exception as e:
                log.warning('query_knowledge_files: external knowledge %s failed: %s', knowledge.id, e)
                failed.append(f'{knowledge.name}: {e}')
                continue
            sources.append(_external_chunks(query_results, knowledge))

        hits = _take_turns(sources)[:count]
        # Nothing else answered: an empty list would read as "nothing
        # relevant" when the base could not be reached at all.
        if failed and not notes and not hits:
            return JSONCodec.dumps({'error': 'External knowledge unavailable: ' + '; '.join(failed)})
        return JSONCodec.dumps(notes + hits, ensure_ascii=False)
    except Exception as e:
        log.exception(f'query_knowledge_files error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def query_knowledge_bases(
    query: str,
    count: int = 5,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search knowledge bases by semantic similarity to query.
    Finds KBs whose name/description match the meaning of your query.
    Helpful for discovering which knowledge base to query next.

    :param query: Natural language query describing what you're looking for
    :param count: Maximum results (default: 5)
    :return: JSON with matching KBs (id, name, description, similarity)
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        import heapq

        from local_llm.models.knowledge import Knowledges
        from local_llm.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT
        from local_llm.routers.knowledge import KNOWLEDGE_BASES_COLLECTION

        user_id = __user__.get('id')
        user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]
        embedding_function = getattr(__request__.app.state, 'EMBEDDING_FUNCTION', None)
        if not embedding_function:
            return JSONCodec.dumps({'error': 'Embedding function not configured'})
        user_model = UserModel(**__user__)
        query_embedding = await embedding_function(query, prefix=RAG_EMBEDDING_QUERY_PREFIX, user=user_model)

        # Min-heap of (distance, knowledge_base_id) - only holds top `count` results
        top_results_heap = []
        seen_ids = set()
        page_offset = 0
        page_size = 100

        while True:
            accessible_knowledge_bases = await Knowledges.search_knowledge_bases(
                user_id,
                filter={'user_id': user_id, 'group_ids': user_group_ids},
                skip=page_offset,
                limit=page_size,
            )

            if not accessible_knowledge_bases.items:
                break

            accessible_ids = [kb.id for kb in accessible_knowledge_bases.items]

            search_results = await ASYNC_VECTOR_DB_CLIENT.search(
                collection_name=KNOWLEDGE_BASES_COLLECTION,
                vectors=[query_embedding],
                filter={'knowledge_base_id': {'$in': accessible_ids}},
                limit=count,
            )

            if search_results and search_results.ids and search_results.ids[0]:
                result_ids = search_results.ids[0]
                result_distances = search_results.distances[0] if search_results.distances else [0] * len(result_ids)

                for knowledge_base_id, distance in zip(result_ids, result_distances, strict=True):
                    if knowledge_base_id in seen_ids:
                        continue
                    seen_ids.add(knowledge_base_id)

                    if len(top_results_heap) < count:
                        heapq.heappush(top_results_heap, (distance, knowledge_base_id))
                    elif distance > top_results_heap[0][0]:
                        heapq.heapreplace(top_results_heap, (distance, knowledge_base_id))

            page_offset += page_size
            if len(accessible_knowledge_bases.items) < page_size:
                break
            if page_offset >= MAX_KNOWLEDGE_BASE_SEARCH_ITEMS:
                break

        # Sort by distance descending (best first) and fetch KB details
        sorted_results = sorted(top_results_heap, key=lambda x: x[0], reverse=True)

        matching_knowledge_bases = []
        for distance, knowledge_base_id in sorted_results:
            knowledge_base = await Knowledges.get_knowledge_by_id(knowledge_base_id)
            if knowledge_base:
                matching_knowledge_bases.append(
                    {
                        'id': knowledge_base.id,
                        'name': knowledge_base.name,
                        'description': knowledge_base.description or '',
                        'similarity': round(distance, 4),
                    }
                )

        return JSONCodec.dumps(matching_knowledge_bases, ensure_ascii=False)

    except Exception as e:
        log.exception(f'query_knowledge_bases error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# SKILLS TOOLS
# =============================================================================


async def view_skill(
    id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Load the full instructions of a skill by its id from the available skills manifest.
    Use this when you need detailed instructions for a skill listed in <available_skills>.

    :param id: The id of the skill to load (as shown in the manifest)
    :return: The full skill instructions as markdown content
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.access_grants import AccessGrants
        from local_llm.models.skills import Skills

        user_id = __user__.get('id')

        # Direct DB lookup by id (case-insensitive since IDs are stored lowercase)
        skill = await Skills.get_skill_by_id(id.lower())

        if not skill or not skill.is_active:
            return JSONCodec.dumps({'error': f"Skill '{id}' not found"})

        # Check user access
        user_role = __user__.get('role', 'user')
        if user_role != 'admin' and skill.user_id != user_id:
            user_group_ids = [group.id for group in await Groups.get_groups_by_member_id(user_id)]
            if not await AccessGrants.has_access(
                user_id=user_id,
                resource_type='skill',
                resource_id=skill.id,
                permission='read',
                user_group_ids=set(user_group_ids),
            ):
                return JSONCodec.dumps({'error': 'Access denied'})

        return JSONCodec.dumps(
            {
                'name': skill.name,
                'content': skill.content,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'view_skill error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# TASK MANAGEMENT TOOLS
# =============================================================================


VALID_TASK_STATUSES = {'pending', 'in_progress', 'completed', 'cancelled'}


class TaskItem(BaseModel):
    id: str | None = Field(None, description='Unique identifier for the task. Auto-generated if omitted.')
    content: str = Field(..., description='Task description.')
    status: Literal['pending', 'in_progress', 'completed', 'cancelled'] = Field('pending', description='Task status.')


def _task_summary(all_tasks: list[dict]) -> dict:
    """Build summary counts for a task list."""
    pending = sum(1 for t in all_tasks if t['status'] == 'pending')
    in_progress = sum(1 for t in all_tasks if t['status'] == 'in_progress')
    completed = sum(1 for t in all_tasks if t['status'] == 'completed')
    cancelled = sum(1 for t in all_tasks if t['status'] == 'cancelled')
    return {
        'total': len(all_tasks),
        'pending': pending,
        'in_progress': in_progress,
        'completed': completed,
        'cancelled': cancelled,
    }


async def _emit_tasks(event_emitter, all_tasks: list[dict]):
    """Persist task state to the UI."""
    if event_emitter:
        await event_emitter(
            {
                'type': 'chat:message:tasks',
                'data': {
                    'tasks': all_tasks,
                },
            }
        )


async def create_tasks(
    tasks: list[TaskItem],
    __chat_id__: str = None,
    __message_id__: str = None,
    __event_emitter__: callable = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Create a visible task checklist for multi-step work so progress can be shown in chat.

    :param tasks: List of task items. Each item: content (string, required), status (pending|in_progress|completed|cancelled, default pending), id (optional, auto-generated).
    :return: JSON with the full task list and summary counts
    """  # noqa: E501 - the model reads this docstring as the tool description
    if not is_saved_chat_id(__chat_id__):
        return JSONCodec.dumps({'error': 'Saved chat context not available'})

    try:
        all_tasks = []
        for idx, task in enumerate(tasks):
            if hasattr(task, 'model_dump'):
                d = task.model_dump(exclude_none=True)
            elif isinstance(task, dict):
                d = task
            else:
                d = dict(task)

            content = str(d.get('content', '')).strip()
            if not content:
                continue

            item_id = str(d.get('id', '') or '').strip() or str(idx + 1)
            status = str(d.get('status', 'pending')).strip().lower()
            if status not in VALID_TASK_STATUSES:
                status = 'pending'

            all_tasks.append({'id': item_id, 'content': content, 'status': status})

        await Chats.update_chat_tasks_by_id(__chat_id__, all_tasks)
        await _emit_tasks(__event_emitter__, all_tasks)

        return JSONCodec.dumps(
            {'tasks': all_tasks, 'summary': _task_summary(all_tasks)},
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'tasks error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def update_task(
    id: str,
    status: str = 'completed',
    __chat_id__: str = None,
    __message_id__: str = None,
    __event_emitter__: callable = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Mark a single visible task item as completed, in_progress, pending, or cancelled.

    :param id: The task ID to update
    :param status: New status: completed, in_progress, pending, or cancelled (default: completed)
    :return: JSON with the updated task list and summary counts
    """
    if not is_saved_chat_id(__chat_id__):
        return JSONCodec.dumps({'error': 'Saved chat context not available'})

    try:
        status = status.strip().lower()
        if status not in VALID_TASK_STATUSES:
            return JSONCodec.dumps(
                {'error': f'Invalid status: {status}. Must be one of: {", ".join(sorted(VALID_TASK_STATUSES))}'}
            )

        all_tasks = await Chats.get_chat_tasks_by_id(__chat_id__)

        found = False
        for task in all_tasks:
            if task['id'] == id:
                task['status'] = status
                found = True
                break

        if not found:
            return JSONCodec.dumps({'error': f'Task with id "{id}" not found'})

        await Chats.update_chat_tasks_by_id(__chat_id__, all_tasks)
        await _emit_tasks(__event_emitter__, all_tasks)

        return JSONCodec.dumps(
            {'tasks': all_tasks, 'summary': _task_summary(all_tasks)},
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'update_task_status error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# AUTOMATION TOOLS
# =============================================================================


async def _validate_owned_automation_folder(user_id: str, folder_id: str | None) -> str | None:
    if not folder_id:
        return None
    from local_llm.models.folders import Folders

    folder = await Folders.get_folder_by_id_and_user_id(folder_id, user_id)
    if not folder:
        raise ValueError('Folder not found')
    return folder.id


async def create_automation(
    name: str,
    prompt: str,
    rrule: str,
    folder_id: str | None = None,
    __request__: Request = None,
    __user__: dict = None,
    __metadata__: dict = None,
) -> str:
    """
    Create a scheduled automation that runs a prompt on a recurring or one-time schedule.
    Use this when the user wants to schedule a task to run automatically.
    The automation will use the current chat model.

    The rrule parameter must be a valid iCalendar RRULE string. Common examples:
    - Every day at 9am: "DTSTART:20250101T090000\\nRRULE:FREQ=DAILY"
    - Every Monday at 8am: "DTSTART:20250106T080000\\nRRULE:FREQ=WEEKLY;BYDAY=MO"
    - Every hour: "RRULE:FREQ=HOURLY;INTERVAL=1"
    - Every 30 minutes: "RRULE:FREQ=MINUTELY;INTERVAL=30"
    - Once at a specific time: "DTSTART:20250415T140000\\nRRULE:FREQ=DAILY;COUNT=1"
    - First day of every month: "DTSTART:20250101T090000\\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1"

    The DTSTART time should reflect the desired execution time. Use COUNT=1 for one-time automations.

    :param name: A short descriptive name for the automation
    :param prompt: The prompt/instructions to execute on each run
    :param rrule: An iCalendar RRULE string defining the schedule
    :param folder_id: Optional owner-owned folder ID for generated chats
    :return: JSON with the created automation details including id, next scheduled runs
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.automations import AutomationData, AutomationForm, Automations, AutomationTarget
        from local_llm.models.users import Users
        from local_llm.routers.automations import check_automation_limits
        from local_llm.utils.automations import next_n_runs_ns, next_run_ns, pin_rule_time, validate_rrule

        user_id = __user__.get('id')
        user = await Users.get_user_by_id(user_id)
        if not user:
            return JSONCodec.dumps({'error': 'User not found'})

        # Fall back to model dict ID since __metadata__ may predate model_id assignment
        metadata = __metadata__ or {}
        model_id = metadata.get('model_id') or (
            metadata.get('model', {}).get('id') if isinstance(metadata.get('model'), dict) else None
        )
        if not model_id:
            return JSONCodec.dumps({'error': 'Could not detect current model'})

        try:
            folder_id = await _validate_owned_automation_folder(user_id, folder_id)
        except ValueError as e:
            return JSONCodec.dumps({'error': str(e)})

        # Validate the RRULE
        try:
            validate_rrule(rrule, tz=user.timezone)
        except ValueError as e:
            return JSONCodec.dumps({'error': f'Invalid schedule: {e}'})

        try:
            await check_automation_limits(__request__, user, rrule, None, is_create=True)
        except HTTPException as e:
            return JSONCodec.dumps({'error': e.detail})

        tz = user.timezone
        rrule = pin_rule_time(rrule, tz=tz)
        form = AutomationForm(
            name=name,
            folder_id=folder_id,
            data=AutomationData(
                prompt=prompt,
                model_id=model_id,
                rrule=rrule,
                target=(
                    AutomationTarget(type='channel', channel_id=metadata.get('chat_id', '').removeprefix('channel:'))
                    if metadata.get('chat_id', '').startswith('channel:')
                    else None
                ),
            ),
            is_active=True,
        )

        automation = await Automations.insert(user_id, form, next_run_ns(rrule, tz=tz))

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': automation.id,
                'name': automation.name,
                'folder_id': automation.folder_id,
                'model_id': model_id,
                'target': automation.data.get('target'),
                'is_active': automation.is_active,
                'next_runs': next_n_runs_ns(rrule, tz=tz),
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'create_automation error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def update_automation(
    automation_id: str,
    name: str | None = None,
    prompt: str | None = None,
    rrule: str | None = None,
    model_id: str | None = None,
    folder_id: str | None = '',
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Update an existing automation. Only the provided fields are changed; omitted fields stay the same.

    :param automation_id: The ID of the automation to update
    :param name: New name for the automation (optional)
    :param prompt: New prompt/instructions (optional)
    :param rrule: New iCalendar RRULE schedule string (optional). See create_automation for format examples.
    :param model_id: New model ID to use (optional); blank values are ignored
    :param folder_id: New owner-owned folder ID (optional); omit or pass blank to keep unchanged, pass null to clear
    :return: JSON with the updated automation details
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.automations import AutomationData, AutomationForm, Automations, AutomationTarget
        from local_llm.models.users import Users
        from local_llm.routers.automations import check_automation_limits
        from local_llm.utils.automations import next_n_runs_ns, next_run_ns, pin_rule_time, validate_rrule

        user_id = __user__.get('id')
        user = await Users.get_user_by_id(user_id)
        if not user:
            return JSONCodec.dumps({'error': 'User not found'})

        automation = await Automations.get_by_id(automation_id)
        if not automation:
            return JSONCodec.dumps({'error': 'Automation not found'})
        if automation.user_id != user_id:
            return JSONCodec.dumps({'error': 'Access denied'})

        # Merge provided fields with existing values
        new_name = name if name is not None else automation.name
        new_prompt = prompt if prompt is not None else automation.data.get('prompt', '')
        new_model_id = model_id.strip() if model_id and model_id.strip() else automation.data.get('model_id', '')
        new_rrule = rrule if rrule is not None else automation.data.get('rrule', '')
        if folder_id is None:
            new_folder_id = None
        elif not folder_id.strip():
            new_folder_id = automation.folder_id
        else:
            try:
                new_folder_id = await _validate_owned_automation_folder(user_id, folder_id.strip())
            except ValueError as e:
                return JSONCodec.dumps({'error': str(e)})

        # Validate RRULE if changed
        if rrule is not None:
            try:
                validate_rrule(new_rrule, tz=user.timezone)
            except ValueError as e:
                return JSONCodec.dumps({'error': f'Invalid schedule: {e}'})

        try:
            await check_automation_limits(__request__, user, new_rrule, None)
        except HTTPException as e:
            return JSONCodec.dumps({'error': e.detail})

        tz = user.timezone
        new_rrule = pin_rule_time(new_rrule, tz=tz)
        form = AutomationForm(
            name=new_name,
            folder_id=new_folder_id,
            data=AutomationData(
                prompt=new_prompt,
                model_id=new_model_id,
                rrule=new_rrule,
                target=AutomationTarget(**automation.data['target']) if automation.data.get('target') else None,
            ),
            is_active=automation.is_active,
        )

        updated = await Automations.update_by_id(automation_id, form, next_run_ns(new_rrule, tz=tz))

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': updated.id,
                'name': updated.name,
                'folder_id': updated.folder_id,
                'model_id': new_model_id,
                'target': updated.data.get('target'),
                'is_active': updated.is_active,
                'next_runs': next_n_runs_ns(new_rrule, tz=tz),
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'update_automation error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def list_automations(
    status: str | None = None,
    folder_id: str | None = None,
    count: int = 10,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    List the user's scheduled automations.

    :param status: Filter by status: "active", "paused", or omit for all
    :param folder_id: Optional owner-owned folder ID filter; pass an empty string to clear the folder filter
    :param count: Maximum number of automations to return (default: 10)
    :return: JSON list of automations with id, name, prompt snippet, schedule, status, and next runs
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.automations import Automations
        from local_llm.models.users import Users
        from local_llm.utils.automations import next_n_runs_ns

        user_id = __user__.get('id')
        user = await Users.get_user_by_id(user_id)
        if folder_id:
            try:
                folder_id = await _validate_owned_automation_folder(user_id, folder_id)
            except ValueError as e:
                return JSONCodec.dumps({'error': str(e)})

        result = await Automations.search_automations(
            user_id=user_id,
            status=status,
            folder_id=folder_id,
            skip=0,
            limit=count,
        )

        automations = []
        for item in result.items:
            rrule = item.data.get('rrule', '')
            prompt_text = item.data.get('prompt', '')
            snippet = prompt_text[:100] + ('...' if len(prompt_text) > 100 else '')

            automations.append(
                {
                    'id': item.id,
                    'name': item.name,
                    'folder_id': item.folder_id,
                    'prompt_snippet': snippet,
                    'model_id': item.data.get('model_id', ''),
                    'target': item.data.get('target'),
                    'rrule': rrule,
                    'is_active': item.is_active,
                    'last_run_at': item.last_run_at,
                    'next_runs': next_n_runs_ns(rrule, tz=user.timezone if user else None),
                }
            )

        return JSONCodec.dumps(
            {'automations': automations, 'total': result.total},
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'list_automations error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def toggle_automation(
    automation_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Pause or resume a scheduled automation. If active, it will be paused. If paused, it will be resumed.

    :param automation_id: The ID of the automation to toggle
    :return: JSON with the updated automation status
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.automations import Automations
        from local_llm.models.users import Users
        from local_llm.utils.automations import next_run_ns

        user_id = __user__.get('id')
        user = await Users.get_user_by_id(user_id)

        automation = await Automations.get_by_id(automation_id)
        if not automation:
            return JSONCodec.dumps({'error': 'Automation not found'})
        if automation.user_id != user_id:
            return JSONCodec.dumps({'error': 'Access denied'})

        rrule = automation.data.get('rrule', '')
        toggled = await Automations.toggle(
            automation_id,
            next_run_ns(rrule, tz=user.timezone if user else None),
        )

        return JSONCodec.dumps(
            {
                'status': 'success',
                'id': toggled.id,
                'name': toggled.name,
                'is_active': toggled.is_active,
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'toggle_automation error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def delete_automation(
    automation_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Delete a scheduled automation and all its run history.

    :param automation_id: The ID of the automation to delete
    :return: JSON confirming the automation was deleted
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.automations import AutomationRuns, Automations

        user_id = __user__.get('id')

        automation = await Automations.get_by_id(automation_id)
        if not automation:
            return JSONCodec.dumps({'error': 'Automation not found'})
        if automation.user_id != user_id:
            return JSONCodec.dumps({'error': 'Access denied'})

        name = automation.name
        await AutomationRuns.delete_by_automation(automation_id)
        await Automations.delete(automation_id)

        return JSONCodec.dumps(
            {
                'status': 'success',
                'message': f'Automation "{name}" deleted',
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'delete_automation error: {e}')
        return JSONCodec.dumps({'error': str(e)})


# =============================================================================
# CALENDAR TOOLS
# =============================================================================


MAX_CALENDAR_RANGE_END_NS = 2**63 - 1


def _get_user_tz(user_dict: dict):
    """Get the user's timezone as a ZoneInfo, falling back to UTC."""
    from zoneinfo import ZoneInfo

    tz_name = None
    if user_dict:
        tz_name = user_dict.get('timezone')
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except Exception:
            pass
    return ZoneInfo('UTC')


def _dt_to_ns(dt_str: str, tz) -> int:
    """Convert a datetime string to nanoseconds since epoch, interpreting in the given timezone."""

    when = dt.datetime.fromisoformat(dt_str)
    # If naive (no timezone info), localize to user's timezone
    if when.tzinfo is None:
        when = when.replace(tzinfo=tz)
    return int(when.timestamp() * 1_000) * 1_000_000


def _ns_to_dt(ns: int, tz) -> str:
    """Convert nanoseconds since epoch to a datetime string in the given timezone."""

    seconds = ns / 1_000_000_000
    when = dt.datetime.fromtimestamp(seconds, tz=tz)
    return when.strftime('%Y-%m-%d %H:%M')


def _event_to_dict(event, tz) -> dict:
    """Convert a calendar event model to a human-friendly dict with local timestamps."""
    alert_minutes = None
    if event.meta and 'alert_minutes' in event.meta:
        alert_minutes = event.meta['alert_minutes']
    return {
        'id': event.id,
        'calendar_id': event.calendar_id,
        'title': event.title,
        'description': event.description or '',
        'start': _ns_to_dt(event.start_at, tz),
        'end': _ns_to_dt(event.end_at, tz) if event.end_at else None,
        'all_day': event.all_day,
        'location': event.location or '',
        'reminder_minutes': alert_minutes if alert_minutes is not None else 10,
        'color': event.color,
        'rrule': event.rrule,
        'is_cancelled': event.is_cancelled,
    }


# How far ahead a recurring event is listed when a calendar search gives no end.
_RECURRING_HORIZON_NS = 366 * 24 * 3600 * 1_000_000_000


def _overlaps(start_at: int, end_at: int | None, range_start: int, range_end: int) -> bool:
    """Whether an event overlaps [range_start, range_end), as get_events_by_range decides it for a one-off."""
    if start_at >= range_end:
        return False
    return start_at >= range_start or (end_at is not None and end_at > range_start)


async def search_calendar_events(
    query: str | None = None,
    start: str | None = None,
    end: str | None = None,
    count: int = 10,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Search calendar events, reminders, and scheduled items by text and/or date range.
    Helpful for finding upcoming events, reminders, or schedule items.

    :param query: Search text to match against event title, description, or location (optional)
    A repeating event (one with an `rrule`) is listed once per occurrence in
    the range, every occurrence under the series' `id`: updating or deleting
    that id changes every occurrence. Without `end`, occurrences are listed
    up to a year after `start`.

    :param query: Search text to match against event title, description, or location (optional)
    :param start: Only return events still running at or after this datetime, e.g. "2026-04-20 00:00" (an event
        with no end must start at or after it) (optional)
    :param end: Only return events starting before this datetime, e.g. "2026-04-27 00:00" (optional)
    :param count: Maximum number of events to return (default: 10)
    :return: JSON list of matching events with id, title, description, start, end, calendar_id, location, rrule
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.calendar import CalendarEventModel, CalendarEvents
        from local_llm.utils.calendar import expand_recurring_event

        user_id = __user__.get('id')
        tz = _get_user_tz(__user__)

        if isinstance(count, str):
            try:
                count = int(count)
            except ValueError:
                count = 10

        if start or end:
            # Date range query — use get_events_by_range
            try:
                start_ns = _dt_to_ns(start, tz) if start else 0
            except (ValueError, TypeError) as e:
                return JSONCodec.dumps({'error': f'Invalid start datetime: {e}'})

            try:
                end_ns = _dt_to_ns(end, tz) if end else MAX_CALENDAR_RANGE_END_NS
            except (ValueError, TypeError) as e:
                return JSONCodec.dumps({'error': f'Invalid end datetime: {e}'})

            stored = await CalendarEvents.get_events_by_range(
                user_id=user_id,
                start=start_ns,
                end=end_ns,
            )
            # The range query returns every recurring event whatever its
            # dates (#176). Expand each into the occurrences that overlap the
            # range, as the calendar router does (#171).
            # A series whose rule cannot be expanded comes back as its own
            # row and is kept only if that row overlaps the range, like a
            # one-off. Without an end, stop a year out rather than at the
            # expansion's cap of 5,000 occurrences.
            expand_end = end_ns if end else min(end_ns, start_ns + _RECURRING_HORIZON_NS)
            items = []
            for event in stored:
                if not event.rrule:
                    items.append(event)
                    continue
                instances = await asyncio.to_thread(
                    expand_recurring_event, event.model_dump(), start_ns, expand_end, tz=tz.key
                )
                items.extend(
                    CalendarEventModel.model_validate(inst)
                    for inst in instances
                    if _overlaps(inst['start_at'], inst.get('end_at'), start_ns, end_ns)
                )
            items.sort(key=lambda e: e.start_at)

            # Apply text filter if query is also provided
            if query:
                q = query.lower()
                items = [
                    e
                    for e in items
                    if q in (e.title or '').lower()
                    or q in (e.description or '').lower()
                    or q in (e.location or '').lower()
                ]

            events = [_event_to_dict(item, tz) for item in items[:count]]
            return JSONCodec.dumps(
                {'events': events, 'total': len(items)},
                ensure_ascii=False,
            )
        else:
            # Text-only search
            result = await CalendarEvents.search_events(
                user_id=user_id,
                query=query,
                skip=0,
                limit=count,
            )

            events = [_event_to_dict(item, tz) for item in result.items]
            return JSONCodec.dumps(
                {'events': events, 'total': result.total},
                ensure_ascii=False,
            )
    except Exception as e:
        log.exception(f'search_calendar_events error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def create_calendar_event(
    title: str,
    start: str,
    end: str | None = None,
    description: str | None = None,
    calendar_id: str | None = None,
    all_day: bool = False,
    location: str | None = None,
    reminder_minutes: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Create a calendar event, reminder, or alarm. Use this when the user wants to
    schedule an event, set a reminder, create an alarm, or says things like
    "remind me", "don't let me forget", "notify me at", or "add to my calendar".
    For simple reminders, omit end/location/all_day and set reminder_minutes to 0.

    :param title: Event or reminder title (e.g. "Team standup", "Take medicine", "Call mom")
    :param start: Start datetime in the user's local time (e.g. "2026-04-20 09:00")
    :param end: End datetime in the user's local time (optional — omit for reminders or point-in-time events)
    :param description: Event description or notes (optional)
    :param calendar_id: Target calendar ID (optional, uses default calendar if omitted)
    :param all_day: Whether this is an all-day event (default: false)
    :param location: Event location (optional)
    :param reminder_minutes: Minutes before the event to send a notification (optional, default: 10). Use 0 for "at time of event", -1 for no notification; at most 1320 (22 hours before).
    :return: JSON with the created event details including id
    """  # noqa: E501 - the model reads this docstring as the tool description
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.calendar import CalendarEventForm, CalendarEvents, Calendars

        user_id = __user__.get('id')

        # Resolve calendar_id: use provided, or fall back to default
        if not calendar_id:
            calendars = await Calendars.get_calendars_by_user(user_id)
            # is_default is the owner's flag: a calendar shared with this user
            # can carry its owner's, and listed first it took the event (#182).
            own = [c for c in calendars if c.user_id == user_id]
            default_cal = next((c for c in own if c.is_default), None) or next(iter(own), None)
            if not default_cal and calendars:
                default_cal = calendars[0]
            if not default_cal:
                return JSONCodec.dumps({'error': 'No calendars found. Cannot create event.'})
            calendar_id = default_cal.id

        # Verify access
        cal = await Calendars.get_calendar_by_id(calendar_id)
        if not cal:
            return JSONCodec.dumps({'error': 'Calendar not found'})
        if cal.user_id != user_id and __user__.get('role') != 'admin':
            from local_llm.models.access_grants import AccessGrants
            from local_llm.models.groups import Groups

            user_group_ids = [g.id for g in await Groups.get_groups_by_member_id(user_id)]
            if not await AccessGrants.has_access(
                user_id=user_id,
                resource_type='calendar',
                resource_id=cal.id,
                permission='write',
                user_group_ids=set(user_group_ids),
            ):
                return JSONCodec.dumps({'error': 'Access denied to this calendar'})

        # Coerce boolean from LLM
        if isinstance(all_day, str):
            all_day = all_day.lower() in ('true', '1', 'yes')

        # Convert datetime strings to nanoseconds using user's timezone
        tz = _get_user_tz(__user__)
        try:
            start_ns = _dt_to_ns(start, tz)
        except (ValueError, TypeError) as e:
            return JSONCodec.dumps({'error': f'Invalid start datetime: {e}. Use format like "2026-04-20 09:00"'})

        end_ns = None
        if end:
            try:
                end_ns = _dt_to_ns(end, tz)
            except (ValueError, TypeError) as e:
                return JSONCodec.dumps({'error': f'Invalid end datetime: {e}. Use format like "2026-04-20 10:00"'})
        elif not all_day:
            # Default to 1 hour duration
            end_ns = start_ns + 3_600_000_000_000

        # Build meta with reminder setting
        meta = {}
        if reminder_minutes is not None:
            if isinstance(reminder_minutes, str):
                try:
                    reminder_minutes = int(reminder_minutes)
                except ValueError:
                    reminder_minutes = 10
            meta['alert_minutes'] = reminder_minutes
        else:
            meta['alert_minutes'] = 10

        form = CalendarEventForm(
            calendar_id=calendar_id,
            title=title,
            description=description,
            start_at=start_ns,
            end_at=end_ns,
            all_day=all_day,
            location=location,
            meta=meta,
        )

        event = await CalendarEvents.insert_new_event(user_id, form)
        if not event:
            return JSONCodec.dumps({'error': 'Failed to create event'})

        return JSONCodec.dumps(
            {
                'status': 'success',
                **_event_to_dict(event, tz),
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'create_calendar_event error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def _can_write_event_calendar(event, user: dict) -> bool:
    """Whether this user may change or delete an event: the router's rule, exactly."""
    from local_llm.models.access_grants import AccessGrants
    from local_llm.models.calendar import Calendars
    from local_llm.models.groups import Groups

    if user.get('role') == 'admin':
        return True
    cal = await Calendars.get_calendar_by_id(event.calendar_id)
    if not cal:
        return False
    if cal.user_id == user.get('id'):
        return True
    group_ids = [g.id for g in await Groups.get_groups_by_member_id(user.get('id'))]
    return await AccessGrants.has_access(
        user_id=user.get('id'),
        resource_type='calendar',
        resource_id=cal.id,
        permission='write',
        user_group_ids=set(group_ids),
    )


async def update_calendar_event(
    event_id: str,
    title: str | None = None,
    description: str | None = None,
    start: str | None = None,
    end: str | None = None,
    all_day: bool | None = None,
    location: str | None = None,
    is_cancelled: bool | None = None,
    reminder_minutes: int | None = None,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Update an existing calendar event. Only provided fields are changed;
    omitted fields stay the same.

    :param event_id: The ID of the event to update
    :param title: New event title (optional)
    :param description: New event description (optional)
    :param start: New start datetime string in your local time, e.g. "2026-04-20 09:00" (optional)
    :param end: New end datetime string in your local time (optional)
    :param all_day: Whether this is an all-day event (optional)
    :param location: New event location (optional)
    :param is_cancelled: Set to true to cancel the event (optional)
    :param reminder_minutes: Minutes before the event to send a reminder notification (optional). Use 0 for "at time of event", -1 for no reminder. Accepts any positive integer for custom timing (e.g. 120 for 2 hours before); a reminder comes at most 22 hours (1320 minutes) before.
    :return: JSON with the updated event details
    """  # noqa: E501 - the model reads this docstring as the tool description
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.calendar import CalendarEvents, CalendarEventUpdateForm

        event = await CalendarEvents.get_event_by_id(event_id)
        if not event:
            return JSONCodec.dumps({'error': 'Event not found'})

        # The router's rule (routers/calendar.py _check_calendar_access): the
        # calendar's owner, an admin, or a write grant on the event's calendar.
        # Having created the event is not enough once the grant is revoked.
        if not await _can_write_event_calendar(event, __user__):
            return JSONCodec.dumps({'error': 'Access denied'})

        # Coerce boolean strings from LLM
        if isinstance(all_day, str):
            all_day = all_day.lower() in ('true', '1', 'yes')
        if isinstance(is_cancelled, str):
            is_cancelled = is_cancelled.lower() in ('true', '1', 'yes')

        # Convert datetime strings to nanoseconds using user's timezone
        tz = _get_user_tz(__user__)
        start_ns = None
        if start is not None:
            try:
                start_ns = _dt_to_ns(start, tz)
            except (ValueError, TypeError) as e:
                return JSONCodec.dumps({'error': f'Invalid start datetime: {e}'})

        end_ns = None
        if end is not None:
            try:
                end_ns = _dt_to_ns(end, tz)
            except (ValueError, TypeError) as e:
                return JSONCodec.dumps({'error': f'Invalid end datetime: {e}'})

        # Build meta update with reminder setting if provided
        meta = None
        if reminder_minutes is not None:
            if isinstance(reminder_minutes, str):
                try:
                    reminder_minutes = int(reminder_minutes)
                except ValueError:
                    reminder_minutes = None
            if reminder_minutes is not None:
                meta = {'alert_minutes': reminder_minutes}

        update_fields = {
            'title': title,
            'description': description,
            'start_at': start_ns,
            'end_at': end_ns,
            'all_day': all_day,
            'location': location,
            'is_cancelled': is_cancelled,
            'meta': meta,
        }
        form = CalendarEventUpdateForm(**{k: v for k, v in update_fields.items() if v is not None})

        updated = await CalendarEvents.update_event_by_id(event_id, form)
        if not updated:
            return JSONCodec.dumps({'error': 'Failed to update event'})

        return JSONCodec.dumps(
            {
                'status': 'success',
                **_event_to_dict(updated, tz),
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'update_calendar_event error: {e}')
        return JSONCodec.dumps({'error': str(e)})


async def delete_calendar_event(
    event_id: str,
    __request__: Request = None,
    __user__: dict = None,
) -> str:
    """
    Delete a calendar event permanently.

    :param event_id: The ID of the event to delete
    :return: JSON confirming the event was deleted
    """
    if __request__ is None:
        return JSONCodec.dumps({'error': 'Request context not available'})

    if not __user__:
        return JSONCodec.dumps({'error': 'User context not available'})

    try:
        from local_llm.models.calendar import CalendarEvents

        event = await CalendarEvents.get_event_by_id(event_id)
        if not event:
            return JSONCodec.dumps({'error': 'Event not found'})

        if not await _can_write_event_calendar(event, __user__):
            return JSONCodec.dumps({'error': 'Access denied'})

        title = event.title
        result = await CalendarEvents.delete_event_by_id(event_id)
        if not result:
            return JSONCodec.dumps({'error': 'Failed to delete event'})

        return JSONCodec.dumps(
            {
                'status': 'success',
                'message': f'Event "{title}" deleted',
            },
            ensure_ascii=False,
        )
    except Exception as e:
        log.exception(f'delete_calendar_event error: {e}')
        return JSONCodec.dumps({'error': str(e)})
