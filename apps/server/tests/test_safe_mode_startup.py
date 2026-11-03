"""SAFE_MODE deactivates functions before startup can run any (#361).

The lifespan published SYSTEM_STARTUP_STARTED, which dispatches event
functions, before SAFE_MODE's deactivate_all_functions(), so recovery mode
still loaded and called a broken function at startup, and a failed
deactivation was ignored. Functions are now deactivated first, and a
deactivation that fails stops startup rather than run them.

These drive main.lifespan as far as its first published event, with the
setup before it stubbed, and record any direct dispatch of event functions.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_safe_mode_startup.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm import main


class _FirstPublish(Exception):
    """Raised by the fake publish_event, so the lifespan stops there."""


def _startup(monkeypatch, *, safe_mode: bool, deactivated):
    order: list[str] = []

    async def nothing(*args, **kwargs):
        return None

    async def deactivate_all_functions():
        order.append('deactivate')
        return deactivated

    async def publish_event(app, event, **kwargs):
        order.append(f'publish {event.name}')
        raise _FirstPublish

    monkeypatch.setattr(main, 'SAFE_MODE', safe_mode)
    monkeypatch.setattr(main, 'THREAD_POOL_SIZE', None)
    monkeypatch.setattr(main, 'RESET_CONFIG_ON_START', False)
    monkeypatch.setattr(main, 'start_logger', lambda: None)
    monkeypatch.setattr(main, 'VECTOR_DB_CLIENT', SimpleNamespace(resolve=lambda: None))
    for name in ('import_legacy_config_json', 'seed_registered_defaults', 'initialize_runtime_config'):
        monkeypatch.setattr(main, name, nothing)
    monkeypatch.setattr(main, 'migrate_legacy_webhook_config', nothing)

    async def dispatch_event_functions(*args, **kwargs):
        order.append('dispatch')

    from local_llm import events

    monkeypatch.setattr(main.Functions, 'deactivate_all_functions', deactivate_all_functions)
    monkeypatch.setattr(main, 'publish_event', publish_event)
    # Any startup step that dispatches event functions directly shows up too.
    monkeypatch.setattr(events, 'dispatch_event_functions', dispatch_event_functions)

    async def run():
        async with main.lifespan(SimpleNamespace(state=SimpleNamespace())):
            pass

    return order, run


def test_safe_mode_deactivates_functions_before_the_startup_event(monkeypatch):
    order, run = _startup(monkeypatch, safe_mode=True, deactivated=True)

    with pytest.raises(_FirstPublish):
        asyncio.run(run())

    assert order == ['deactivate', 'publish system.startup.started']


def test_safe_mode_refuses_to_start_when_deactivation_fails(monkeypatch):
    order, run = _startup(monkeypatch, safe_mode=True, deactivated=None)

    with pytest.raises(RuntimeError, match='SAFE_MODE'):
        asyncio.run(run())

    assert order == ['deactivate']


def test_safe_mode_deactivates_before_any_other_startup_step(monkeypatch):
    # Not only before the publish: before the vector store and config steps,
    # so a step added there later cannot run functions first.
    order, run = _startup(monkeypatch, safe_mode=True, deactivated=True)

    def resolve():
        order.append('vector store')

    monkeypatch.setattr(main, 'VECTOR_DB_CLIENT', SimpleNamespace(resolve=resolve))

    with pytest.raises(_FirstPublish):
        asyncio.run(run())

    assert order[0] == 'deactivate'
    assert 'dispatch' not in order


def test_without_safe_mode_nothing_is_deactivated(monkeypatch):
    order, run = _startup(monkeypatch, safe_mode=False, deactivated=True)

    with pytest.raises(_FirstPublish):
        asyncio.run(run())

    assert order == ['publish system.startup.started']
