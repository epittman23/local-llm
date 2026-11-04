import logging
import os

import aiofiles
import aiofiles.os
import aiohttp
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import BaseModel

from local_llm.config import CACHE_DIR
from local_llm.env import AIOHTTP_CLIENT_SESSION_SSL, AIOHTTP_FILE_STREAM_CHUNK_SIZE
from local_llm.events import EVENTS, publish_event
from local_llm.models.config import Config
from local_llm.routers.openai import get_all_models_responses
from local_llm.utils.auth import get_admin_user

log = logging.getLogger(__name__)


##################################
#
# Pipeline Middleware
# Every hand this passes through can corrupt it or
# improve it. Let each stage leave it better than it found.
#
##################################


def get_sorted_filters(model_id, models):
    filters = [
        model
        for model in models.values()
        if 'pipeline' in model
        and 'type' in model['pipeline']
        and model['pipeline']['type'] == 'filter'
        and (
            model['pipeline']['pipelines'] == ['*']
            or any(model_id == target_model_id for target_model_id in model['pipeline']['pipelines'])
        )
    ]
    sorted_filters = sorted(filters, key=lambda x: x['pipeline']['priority'])
    return sorted_filters


async def get_openai_connection(url_idx: int) -> tuple[str, str]:
    base_urls = await Config.get('openai.api_base_urls', [])
    api_keys = await Config.get('openai.api_keys', [])
    return base_urls[url_idx], api_keys[url_idx]


NOT_JSON = 'The Pipelines server sent a reply that is not JSON'


async def _reply_json(response: aiohttp.ClientResponse, fallback: str | None = None):
    """The Pipelines server's JSON reply, read while the `async with` still holds it.

    A failure is raised as an HTTPException with the server's status and its
    own `detail`, else `fallback`, else the status's reason. Read after the
    block had released the response, the body was gone, so every failure
    came out as "Pipeline not found", or a bare reason phrase (#304).
    """
    if response.ok:
        try:
            return await response.json()
        except (aiohttp.ContentTypeError, ValueError) as e:
            # An error, as on `main`, so a filter's chat stops: caught as any
            # other error, the filter (a moderation one, say) would be skipped.
            log.warning(f'Pipelines server sent a reply that is not JSON for {response.url}: {e}')
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=NOT_JSON) from e
    detail = None
    try:
        body = await response.json(content_type=None)
        if isinstance(body, dict):
            detail = body.get('detail')
    except Exception:
        pass
    log.warning(f'Pipelines server answered {response.status} for {response.url}: {detail}')
    raise HTTPException(status_code=response.status, detail=detail or fallback or response.reason)


async def process_pipeline_inlet_filter(request, payload, user, models):
    user = {'id': user.id, 'email': user.email, 'name': user.name, 'role': user.role}
    model_id = payload['model']
    sorted_filters = get_sorted_filters(model_id, models)
    model = models[model_id]

    if 'pipeline' in model:
        sorted_filters.append(model)

    if not sorted_filters:
        return payload

    async with aiohttp.ClientSession(trust_env=True) as session:
        for filter in sorted_filters:
            urlIdx = filter.get('urlIdx')

            try:
                urlIdx = int(urlIdx)
            except Exception:
                continue

            url, key = await get_openai_connection(urlIdx)

            if not key:
                continue

            headers = {'Authorization': f'Bearer {key}'}
            request_data = {
                'user': user,
                'body': payload,
            }

            try:
                async with session.post(
                    f'{url}/{filter["id"]}/filter/inlet',
                    headers=headers,
                    json=request_data,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                ) as response:
                    payload = await _reply_json(response)
            except HTTPException:
                raise
            except Exception as e:
                log.exception(f'Connection error: {e}')

    return payload


async def process_pipeline_outlet_filter(request, payload, user, models):
    user = {'id': user.id, 'email': user.email, 'name': user.name, 'role': user.role}
    model_id = payload['model']
    sorted_filters = get_sorted_filters(model_id, models)
    model = models[model_id]

    if 'pipeline' in model:
        sorted_filters = [model] + sorted_filters

    if not sorted_filters:
        return payload

    async with aiohttp.ClientSession(trust_env=True) as session:
        for filter in sorted_filters:
            urlIdx = filter.get('urlIdx')

            try:
                urlIdx = int(urlIdx)
            except Exception:
                continue

            url, key = await get_openai_connection(urlIdx)

            if not key:
                continue

            headers = {'Authorization': f'Bearer {key}'}
            request_data = {
                'user': user,
                'body': payload,
            }

            try:
                async with session.post(
                    f'{url}/{filter["id"]}/filter/outlet',
                    headers=headers,
                    json=request_data,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                ) as response:
                    payload = await _reply_json(response)
            except HTTPException:
                raise
            except Exception as e:
                log.exception(f'Connection error: {e}')

    return payload


##################################
#
# Pipelines Endpoints
#
##################################

router = APIRouter()


@router.get('/list')
async def get_pipelines_list(request: Request, user=Depends(get_admin_user)):
    responses = await get_all_models_responses(request, user)
    log.debug('get_pipelines_list: get_openai_models_responses returned %s', responses)

    urlIdxs = [idx for idx, response in enumerate(responses) if response is not None and 'pipelines' in response]
    base_urls = await Config.get('openai.api_base_urls', [])

    return {
        'data': [
            {
                'url': base_urls[urlIdx],
                'idx': urlIdx,
            }
            for urlIdx in urlIdxs
        ]
    }


@router.post('/upload')
async def upload_pipeline(
    request: Request,
    urlIdx: int = Form(...),
    file: UploadFile = File(...),
    user=Depends(get_admin_user),
):
    log.info('upload_pipeline: urlIdx=%s, filename=%s', urlIdx, file.filename)
    filename = os.path.basename(file.filename)

    # Check if the uploaded file is a python file
    if not (filename and filename.endswith('.py')):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Only Python (.py) files are allowed.',
        )

    upload_folder = f'{CACHE_DIR}/pipelines'
    os.makedirs(upload_folder, exist_ok=True)
    file_path = os.path.join(upload_folder, filename)

    response = None
    try:
        async with aiofiles.open(file_path, 'wb') as buffer:
            while chunk := await file.read(AIOHTTP_FILE_STREAM_CHUNK_SIZE):
                await buffer.write(chunk)

        url, key = await get_openai_connection(urlIdx)

        headers = {'Authorization': f'Bearer {key}'}

        async with aiohttp.ClientSession(trust_env=True) as session:
            form_data = aiohttp.FormData()

            async def pipeline_chunks():
                async with aiofiles.open(file_path, 'rb') as pipeline_file:
                    while chunk := await pipeline_file.read(AIOHTTP_FILE_STREAM_CHUNK_SIZE):
                        yield chunk

            form_data.add_field(
                'file',
                pipeline_chunks(),
                filename=filename,
                content_type='application/octet-stream',
            )

            async with session.post(
                f'{url}/pipelines/upload',
                headers=headers,
                data=form_data,
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        await publish_event(
            request,
            EVENTS.PIPELINE_UPLOADED,
            actor=user,
            subject_id=data.get('id') or filename,
            data={'url_idx': urlIdx, 'filename': filename},
        )
        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )
    finally:
        # Ensure the file is deleted after the upload is completed or on failure
        if await aiofiles.os.path.exists(file_path):
            await aiofiles.os.remove(file_path)


class AddPipelineForm(BaseModel):
    url: str
    urlIdx: int


@router.post('/add')
async def add_pipeline(request: Request, form_data: AddPipelineForm, user=Depends(get_admin_user)):
    response = None
    try:
        urlIdx = form_data.urlIdx

        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.post(
                f'{url}/pipelines/add',
                headers={'Authorization': f'Bearer {key}'},
                json={'url': form_data.url},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        await publish_event(
            request,
            EVENTS.PIPELINE_ADDED,
            actor=user,
            subject_id=data.get('id') or form_data.url,
            data={'url_idx': urlIdx, 'url': form_data.url},
        )
        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )


class DeletePipelineForm(BaseModel):
    id: str
    urlIdx: int


@router.delete('/delete')
async def delete_pipeline(request: Request, form_data: DeletePipelineForm, user=Depends(get_admin_user)):
    response = None
    try:
        urlIdx = form_data.urlIdx

        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.delete(
                f'{url}/pipelines/delete',
                headers={'Authorization': f'Bearer {key}'},
                json={'id': form_data.id},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        await publish_event(
            request,
            EVENTS.PIPELINE_DELETED,
            actor=user,
            subject_id=form_data.id,
            data={'url_idx': urlIdx},
        )
        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )


@router.get('/')
async def get_pipelines(request: Request, urlIdx: int | None = None, user=Depends(get_admin_user)):
    response = None
    try:
        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(
                f'{url}/pipelines',
                headers={'Authorization': f'Bearer {key}'},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )


@router.get('/{pipeline_id}/valves')
async def get_pipeline_valves(
    request: Request,
    urlIdx: int | None,
    pipeline_id: str,
    user=Depends(get_admin_user),
):
    response = None
    try:
        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(
                f'{url}/{pipeline_id}/valves',
                headers={'Authorization': f'Bearer {key}'},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )


@router.get('/{pipeline_id}/valves/spec')
async def get_pipeline_valves_spec(
    request: Request,
    urlIdx: int | None,
    pipeline_id: str,
    user=Depends(get_admin_user),
):
    response = None
    try:
        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(
                f'{url}/{pipeline_id}/valves/spec',
                headers={'Authorization': f'Bearer {key}'},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )


@router.post('/{pipeline_id}/valves/update')
async def update_pipeline_valves(
    request: Request,
    urlIdx: int | None,
    pipeline_id: str,
    form_data: dict,
    user=Depends(get_admin_user),
):
    response = None
    try:
        url, key = await get_openai_connection(urlIdx)

        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.post(
                f'{url}/{pipeline_id}/valves/update',
                headers={'Authorization': f'Bearer {key}'},
                json={**form_data},
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                data = await _reply_json(response, 'Pipeline not found')

        # Announced here, on an update, not when the valves are read (#304).
        await publish_event(
            request,
            EVENTS.PIPELINE_VALVES_UPDATED,
            actor=user,
            subject_id=pipeline_id,
            data={'url_idx': urlIdx},
        )
        return {**data}
    except HTTPException:
        raise
    except Exception as e:
        # Handle connection error here
        log.exception(f'Connection error: {e}')
        raise HTTPException(
            status_code=(response.status if response is not None else status.HTTP_404_NOT_FOUND),
            detail='Pipeline not found',
        )
