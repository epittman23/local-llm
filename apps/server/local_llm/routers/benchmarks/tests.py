"""routers/benchmarks/tests.py - run a benchmark suite against the serving model, live.

`prepare_suite()`/`run_items()` in benchmarks.runner already do the real
work (interleaving, resume, grading, recording) and were already designed
to be driven by a web UI's on_record/should_stop callbacks -- this router
is the asyncio.Queue/SSE plumbing around them, replacing the original
dashboard's in-process background-thread version with a background task.
"""

from __future__ import annotations

import asyncio
import json

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from local_llm.benchmarks.evaluation import grading, harness, livecodebench_data, runner
from local_llm.benchmarks.evaluation.adapters import ADAPTERS_DIR, load_adapters
from local_llm.benchmarks.evaluation.datasets import (
    INCREMENTS_KIND,
    DatasetError,
    dataset_identity,
    fetch_one,
    read_items,
    short_revision,
)
from local_llm.benchmarks.evaluation.suites import SUITES_DIR, filter_items
from local_llm.constants import ERROR_MESSAGES
from local_llm.utils.auth import get_admin_user

router = APIRouter()

_task: asyncio.Task | None = None
_queue: asyncio.Queue | None = None
_cancel = False


class FetchForm(BaseModel):
    benchmarks: list[str] | None = None  # None: every benchmark
    force: bool = False
    # LiveCodeBench's release increments to fetch (test.jsonl ... test6.jsonl).
    # None or empty fetches none of them: together they are 4.5 GB.
    increments: list[str] | None = None

    model_config = ConfigDict(extra='forbid')


class SelfcheckForm(BaseModel):
    benchmarks: list[str] | None = None

    model_config = ConfigDict(extra='forbid')


class ItemForm(BaseModel):
    benchmark: str
    item_id: str
    profile: str | None = None
    system: str | None = None
    # A Workspace model entry to answer through the app's chat pipeline
    # (benchmarks/evaluation/harness.py); None sends the item straight to
    # llama-server.
    harness_model: str | None = None

    model_config = ConfigDict(extra='forbid')


class TestsRunForm(BaseModel):
    suite: str
    profile: str | None = None
    benchmark: str | None = None
    system: str | None = None
    slice: str | None = None
    resume: bool = False
    harness_model: str | None = None
    # The release-date window a windowed benchmark (LiveCodeBench) draws its
    # problems from, as YYYY-MM-DD. Without window_min it is left out of a
    # tier; window_max None means no upper bound.
    window_min: str | None = None
    window_max: str | None = None

    model_config = ConfigDict(extra='forbid')


def _windows() -> dict[str, dict]:
    """Each windowed benchmark's increments, which are fetched, and the dates those cover."""
    out = {}
    for name, adapter in sorted(load_adapters().items()):
        if not adapter.get('window'):
            continue
        have = livecodebench_data.present(adapter)
        incs = [
            {
                'name': inc['name'],
                'bytes': inc['bytes'],
                'items': inc['items'],
                'first': inc['first'],
                'last': inc['last'],
                'fetched': inc['name'] in have,
            }
            for inc in livecodebench_data.increments(adapter)
        ]
        fetched = [inc for inc in incs if inc['fetched']]
        out[name] = {
            'increments': incs,
            'date_range': [min(i['first'] for i in fetched), max(i['last'] for i in fetched)] if fetched else None,
        }
    return out


@router.get('/options')
async def get_options(user=Depends(get_admin_user)):
    return {
        'tiers': sorted(p.stem for p in SUITES_DIR.glob('*.toml')),
        'benchmarks': sorted(p.stem for p in ADAPTERS_DIR.glob('*.toml')),
        'systems': runner.system_names(),
        'windows': await asyncio.to_thread(_windows),
    }


async def _run_suite(form: TestsRunForm, queue: asyncio.Queue, request: Request | None = None, user=None) -> None:
    global _cancel
    passed = attempted = 0
    try:
        try:
            window = livecodebench_data.parse_window(form.window_min, form.window_max)
        except ValueError as exc:
            raise runner.SuiteLoadError(f'bad release-date window: {exc}') from exc
        async with aiohttp.ClientSession() as session:
            ctx, todo, skipped = await runner.prepare_suite(
                session,
                suite_name=form.suite,
                profile_name=form.profile,
                benchmark=form.benchmark,
                item_slice=form.slice,
                system_name=form.system,
                resume=form.resume,
                harness_entry=form.harness_model,
                source_request=request,
                user=user,
                window=window,
            )
            total = len(todo)
            await queue.put(
                {
                    'type': 'start',
                    'suite_run_id': ctx['suite_run_id'],
                    'total': total,
                    'skipped': len(skipped),
                    'window': livecodebench_data.window_text(window) if window else None,
                    'notes': ctx.get('notes') or [],
                }
            )

            async def on_record(record: dict) -> None:
                nonlocal passed, attempted
                if record['outcome'] != 'skipped':
                    attempted += 1
                    if record['outcome'] == 'pass':
                        passed += 1
                await queue.put(
                    {
                        'type': 'item',
                        'benchmark': record['benchmark'],
                        'item_id': record['item_id'],
                        'outcome': record['outcome'],
                        'reason': record.get('reason', ''),
                        'i': attempted,
                        'total': total,
                        'passed': passed,
                        'attempted': attempted,
                    }
                )

            def should_stop() -> bool:
                return _cancel

            await runner.run_items(session, todo, ctx, on_record=on_record, should_stop=should_stop)
        await queue.put({'type': 'done', 'passed': passed, 'attempted': attempted, 'cancelled': _cancel})
    except runner.SuiteLoadError as exc:
        await queue.put({'type': 'error', 'message': str(exc)})
    except runner.ServerGone as exc:
        await queue.put({'type': 'error', 'message': f'server gone: {exc}'})
    except harness.HarnessRefused as exc:
        await queue.put({'type': 'error', 'message': f'not recorded: {exc}'})
    except Exception as exc:  # noqa: BLE001 - reported to the client, not swallowed silently
        await queue.put({'type': 'error', 'message': str(exc)})


def active() -> bool:
    """Whether a Tests job (a run, fetch, selfcheck or one item) is running."""
    return _task is not None and not _task.done()


def _start(job) -> dict:
    """Run `job(queue)` as the one Tests job, streamed by /stream.

    One at a time, and never alongside a tune sweep or a pre-screen: a fetch
    would change the datasets under a run, and any of them would compete
    with a sweep for the server, the GPU and the CPU it is measuring.
    """
    global _task, _queue, _cancel
    from local_llm.routers.benchmarks import prescreen as prescreen_router
    from local_llm.routers.benchmarks import tune as tune_router

    if active():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('another test job is already running')
        )
    if tune_router.running():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('a tune sweep is running')
        )
    if prescreen_router.running():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('a pre-screen is running')
        )
    _queue = asyncio.Queue()
    _cancel = False
    _task = asyncio.create_task(job(_queue))
    return {'started': True}


def _benchmarks(names: list[str] | None) -> list[str]:
    """The named benchmarks, all of them for None; 404 for a name no adapter defines.

    Each name becomes a path under the datasets directory, so only adapter ids
    are accepted, never anything a client makes up.
    """
    known = sorted(load_adapters())
    if names is None:
        return known
    unknown = [n for n in names if n not in known]
    if unknown or not names:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.DEFAULT(f'no benchmark {", ".join(map(repr, unknown)) or "given"}'),
        )
    return list(dict.fromkeys(names))


@router.post('/run')
async def start_run(request: Request, form_data: TestsRunForm, user=Depends(get_admin_user)):
    return _start(lambda queue: _run_suite(form_data, queue, request, user))


def _short_revision(manifest: dict) -> str:
    return short_revision(manifest.get('revision') or manifest.get('content_sha256', ''))


def _dataset_status() -> list[dict]:
    out = []
    for name, adapter in sorted(load_adapters().items()):
        try:
            manifest = dataset_identity(name)
        except DatasetError as exc:
            # One bad vendored file is that row's problem, not the panel's.
            out.append(
                {
                    'benchmark': name,
                    'name': adapter.get('name', name),
                    'fetched': False,
                    'vendored': True,
                    'n_items': None,
                    'revision': None,
                    'fetched_at': None,
                    'calibrated_at': None,
                    'n_checked': None,
                    'n_ungradeable': None,
                    'calibration_stale': str(exc),
                }
            )
            continue
        calibration = grading.read_calibration(name)
        row = {
            'benchmark': name,
            'name': adapter.get('name', name),
            'fetched': manifest is not None,
            # In the repository: there is nothing to fetch, and Fetch only verifies it.
            'vendored': bool(manifest and manifest.get('vendored')),
            'n_items': manifest.get('n_items') if manifest else None,
            'revision': _short_revision(manifest) if manifest else None,
            'fetched_at': manifest.get('fetched_at') if manifest else None,
            'calibrated_at': calibration.get('checked_at') if calibration else None,
            'n_checked': calibration.get('n_checked') if calibration else None,
            'n_ungradeable': calibration.get('n_ungradeable') if calibration else None,
            'calibration_stale': grading.calibration_stale(name) if manifest else '',
        }
        out.append(row)
    return out


@router.get('/datasets')
async def get_datasets(user=Depends(get_admin_user)):
    """Each benchmark's dataset: fetched or not, its revision, and its calibration."""
    # calibration_stale starts the grading interpreter to fingerprint it.
    return await asyncio.to_thread(_dataset_status)


@router.post('/fetch')
async def start_fetch(form_data: FetchForm, user=Depends(get_admin_user)):
    names = _benchmarks(form_data.benchmarks)
    adapters = load_adapters()

    async def job(queue: asyncio.Queue) -> None:
        loop = asyncio.get_running_loop()
        try:
            for name in names:
                if _cancel:
                    break
                adapter = adapters[name]
                if (adapter.get('fetch') or {}).get('kind') == INCREMENTS_KIND:
                    if not form_data.increments:
                        await queue.put(
                            {'type': 'progress', 'benchmark': name, 'message': 'no increments chosen, so none fetched'}
                        )
                        continue
                    before = dataset_identity(name)
                    manifest = await asyncio.to_thread(
                        livecodebench_data.fetch,
                        adapter,
                        form_data.increments,
                        force=form_data.force,
                        progress=_progress(loop, queue, name),
                        should_stop=lambda: _cancel,
                    )
                else:
                    await queue.put({'type': 'progress', 'benchmark': name, 'message': 'fetching'})
                    before = dataset_identity(name)
                    manifest = await asyncio.to_thread(fetch_one, adapter, form_data.force)
                await queue.put(
                    {
                        'type': 'dataset',
                        'benchmark': name,
                        'n_items': manifest.get('n_items'),
                        'revision': _short_revision(manifest),
                        'fetched': manifest is not before and manifest != before,
                        'vendored': bool(manifest.get('vendored')),
                    }
                )
            await queue.put({'type': 'done', 'cancelled': _cancel})
        except livecodebench_data.Cancelled:
            await queue.put({'type': 'done', 'cancelled': True})
        except Exception as exc:  # noqa: BLE001 - reported to the client
            await queue.put({'type': 'error', 'message': str(exc)})

    return _start(job)


def _progress(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, name: str):
    """A progress callback for a fetch running in a worker thread."""

    def report(message: str) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, {'type': 'progress', 'benchmark': name, 'message': message})

    return report


class _Cancelled(Exception):
    pass


@router.post('/selfcheck')
async def start_selfcheck(form_data: SelfcheckForm, user=Depends(get_admin_user)):
    names = _benchmarks(form_data.benchmarks)
    adapters = load_adapters()

    async def job(queue: asyncio.Queue) -> None:
        loop = asyncio.get_running_loop()
        try:
            for name in names:
                if _cancel:
                    break
                adapter = adapters[name]
                if not grading.calibratable(adapter):
                    message = grading.NOT_CALIBRATABLE
                    await queue.put({'type': 'progress', 'benchmark': name, 'message': message})
                    continue
                items, _ = filter_items(adapter, await asyncio.to_thread(read_items, name))
                total = len(items)
                await queue.put({'type': 'progress', 'benchmark': name, 'message': 'checking', 'total': total})
                counts = {'i': 0, 'passed': 0}

                def on_item(iid: str, outcome: str, reason: str, name=name, total=total, counts=counts) -> None:
                    # In the grading thread: stop on cancel, before anything is written.
                    if _cancel:
                        raise _Cancelled()
                    counts['i'] += 1
                    counts['passed'] += outcome == grading.PASS
                    event = {
                        'type': 'reference',
                        'benchmark': name,
                        'item_id': iid,
                        'outcome': outcome,
                        'reason': reason,
                        'i': counts['i'],
                        'total': total,
                        'passed': counts['passed'],
                    }
                    loop.call_soon_threadsafe(queue.put_nowait, event)

                record = await asyncio.to_thread(grading.calibrate, name, adapter, items, on_item)
                await asyncio.to_thread(grading.write_calibration, name, record)
                await queue.put(
                    {
                        'type': 'calibrated',
                        'benchmark': name,
                        'n_checked': record['n_checked'],
                        'n_ungradeable': record['n_ungradeable'],
                    }
                )
            await queue.put({'type': 'done', 'cancelled': _cancel})
        except _Cancelled:
            await queue.put({'type': 'done', 'cancelled': True})
        except Exception as exc:  # noqa: BLE001 - reported to the client
            await queue.put({'type': 'error', 'message': str(exc)})

    return _start(job)


@router.post('/item')
async def start_item(request: Request, form_data: ItemForm, user=Depends(get_admin_user)):
    """Ask and grade one item against what is being served; nothing is recorded."""
    (name,) = _benchmarks([form_data.benchmark])

    async def job(queue: asyncio.Queue) -> None:
        try:
            async with aiohttp.ClientSession() as session:
                result = await runner.run_one(
                    session,
                    benchmark=name,
                    item=form_data.item_id,
                    profile_name=form_data.profile,
                    system_name=form_data.system,
                    harness_entry=form_data.harness_model,
                    source_request=request,
                    user=user,
                )
            await queue.put({'type': 'result', **result})
            await queue.put({'type': 'done', 'cancelled': False})
        except runner.ServerGone as exc:
            await queue.put({'type': 'error', 'message': f'server gone: {exc}'})
        except harness.HarnessRefused as exc:
            await queue.put({'type': 'error', 'message': f'not recorded: {exc}'})
        except Exception as exc:  # noqa: BLE001 - reported to the client
            await queue.put({'type': 'error', 'message': str(exc)})

    return _start(job)


async def shutdown() -> None:
    """Cancel a running Tests job and wait for it.

    The cooperative flag first, so a run stops between items, then the task
    itself. A grade already in its worker thread finishes on its own timeout
    and kills its subprocess's group on the way out
    (benchmarks.evaluation.grading). The caller bounds the wait.
    """
    global _cancel
    if not active():
        return
    _cancel = True
    _task.cancel()
    await asyncio.wait({_task})


@router.post('/cancel')
async def cancel_run(user=Depends(get_admin_user)):
    global _cancel
    if not active():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    _cancel = True
    return {'cancelling': True}


@router.get('/stream')
async def stream_run(user=Depends(get_admin_user)):
    queue = _queue
    if queue is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)

    async def event_stream():
        while True:
            message = await queue.get()
            yield f'data: {json.dumps(message)}\n\n'
            if message['type'] in ('done', 'error'):
                break

    return StreamingResponse(event_stream(), media_type='text/event-stream')
