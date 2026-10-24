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
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from local_llm.benchmarks.evaluation import grading, runner
from local_llm.benchmarks.evaluation.adapters import ADAPTERS_DIR, load_adapters
from local_llm.benchmarks.evaluation.datasets import fetch_one, read_items, read_manifest
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

    model_config = ConfigDict(extra='forbid')


class SelfcheckForm(BaseModel):
    benchmarks: list[str] | None = None

    model_config = ConfigDict(extra='forbid')


class ItemForm(BaseModel):
    benchmark: str
    item_id: str
    profile: str | None = None
    system: str | None = None

    model_config = ConfigDict(extra='forbid')


class TestsRunForm(BaseModel):
    suite: str
    profile: str | None = None
    benchmark: str | None = None
    system: str | None = None
    slice: str | None = None
    resume: bool = False

    model_config = ConfigDict(extra='forbid')


@router.get('/options')
async def get_options(user=Depends(get_admin_user)):
    return {
        'tiers': sorted(p.stem for p in SUITES_DIR.glob('*.toml')),
        'benchmarks': sorted(p.stem for p in ADAPTERS_DIR.glob('*.toml')),
        'systems': runner.system_names(),
    }


async def _run_suite(form: TestsRunForm, queue: asyncio.Queue) -> None:
    global _cancel
    passed = attempted = 0
    try:
        async with aiohttp.ClientSession() as session:
            ctx, todo, skipped = await runner.prepare_suite(
                session,
                suite_name=form.suite,
                profile_name=form.profile,
                benchmark=form.benchmark,
                item_slice=form.slice,
                system_name=form.system,
                resume=form.resume,
            )
            total = len(todo)
            await queue.put(
                {'type': 'start', 'suite_run_id': ctx['suite_run_id'], 'total': total, 'skipped': len(skipped)}
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
    except Exception as exc:  # noqa: BLE001 - reported to the client, not swallowed silently
        await queue.put({'type': 'error', 'message': str(exc)})


def active() -> bool:
    """Whether a Tests job (a run, fetch, selfcheck or one item) is running."""
    return _task is not None and not _task.done()


def _start(job) -> dict:
    """Run `job(queue)` as the one Tests job, streamed by /stream.

    One at a time, and never alongside a tune sweep: a fetch would change
    the datasets under a run, and any of them would compete with a sweep for
    the server and the CPU it is measuring.
    """
    global _task, _queue, _cancel
    from local_llm.routers.benchmarks import tune as tune_router

    if active():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('another test job is already running')
        )
    if tune_router.running():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('a tune sweep is running')
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
async def start_run(form_data: TestsRunForm, user=Depends(get_admin_user)):
    return _start(lambda queue: _run_suite(form_data, queue))


def _dataset_status() -> list[dict]:
    out = []
    for name, adapter in sorted(load_adapters().items()):
        manifest = read_manifest(name)
        calibration = grading.read_calibration(name)
        row = {
            'benchmark': name,
            'name': adapter.get('name', name),
            'fetched': manifest is not None,
            'n_items': manifest.get('n_items') if manifest else None,
            'revision': (manifest.get('revision') or manifest.get('content_sha256', ''))[:12] if manifest else None,
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
        try:
            for name in names:
                if _cancel:
                    break
                await queue.put({'type': 'progress', 'benchmark': name, 'message': 'fetching'})
                before = read_manifest(name)
                manifest = await asyncio.to_thread(fetch_one, adapters[name], form_data.force)
                await queue.put(
                    {
                        'type': 'dataset',
                        'benchmark': name,
                        'n_items': manifest.get('n_items'),
                        'revision': (manifest.get('revision') or manifest.get('content_sha256', ''))[:12],
                        'fetched': manifest is not before and manifest != before,
                    }
                )
            await queue.put({'type': 'done', 'cancelled': _cancel})
        except Exception as exc:  # noqa: BLE001 - reported to the client
            await queue.put({'type': 'error', 'message': str(exc)})

    return _start(job)


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
async def start_item(form_data: ItemForm, user=Depends(get_admin_user)):
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
                )
            await queue.put({'type': 'result', **result})
            await queue.put({'type': 'done', 'cancelled': False})
        except runner.ServerGone as exc:
            await queue.put({'type': 'error', 'message': f'server gone: {exc}'})
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
