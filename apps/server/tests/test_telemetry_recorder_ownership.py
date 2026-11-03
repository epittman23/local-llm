"""The telemetry recorder opens a run only for the server it was started for (#156).

The recorder used to wait for anything to answer on the serving port. With
an orphaned or hand-started llama-server already on it, the new server
failed to bind, and the recorder opened a run against the old one under
the new configuration's id. Given the server's pid, it now waits for that
process to hold the listening socket, and gives up if it exits first.

These use real sockets and child processes, read through /proc, so they
need Linux (as the backend does).

Run from apps/server:

    python -m pytest tests/test_telemetry_recorder_ownership.py
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time

import pytest

from local_llm.benchmarks.serving import telemetry_recorder as rec

LISTENER = """
import socket, sys, time
s = socket.socket()
s.bind(('127.0.0.1', 0))
s.listen()
print(s.getsockname()[1], flush=True)
time.sleep(60)
"""


@pytest.fixture
def other_process_listener():
    """A child process listening on a loopback port: (process, port)."""
    proc = subprocess.Popen([sys.executable, '-c', LISTENER], stdout=subprocess.PIPE, text=True)
    try:
        port = int(proc.stdout.readline())
        yield proc, port
    finally:
        proc.kill()
        proc.wait()


def test_a_process_owns_the_socket_it_listens_on(other_process_listener):
    proc, port = other_process_listener

    assert rec.owns_listener(proc.pid, port) is True
    assert rec.owns_listener(os.getpid(), port) is False


def test_the_port_is_not_ready_while_another_process_holds_it(other_process_listener):
    _, port = other_process_listener

    assert rec.port_open(port)
    assert rec.server_ready(port, server_pid=os.getpid()) is False
    # A hand-started recorder has no pid, and keeps the bare port check.
    assert rec.server_ready(port, server_pid=None) is True


def test_the_port_is_ready_once_the_server_itself_listens():
    with socket.socket() as own:
        own.bind(('127.0.0.1', 0))
        own.listen()
        assert rec.server_ready(own.getsockname()[1], server_pid=os.getpid()) is True


def test_an_exited_server_is_not_alive_even_as_a_zombie():
    child = subprocess.Popen([sys.executable, '-c', 'pass'])
    deadline = time.time() + 10
    while time.time() < deadline and rec.pid_alive(child.pid):
        time.sleep(0.05)
    # Not reaped yet, so the pid is a zombie; it must still read as gone.
    assert rec.pid_alive(child.pid) is False
    child.wait()
    assert rec.pid_alive(child.pid) is False
    assert rec.pid_alive(os.getpid()) is True


def _args(port: int, server_pid: int | None) -> argparse.Namespace:
    return argparse.Namespace(
        database_url='postgresql://unused',
        config_id='cfg',
        alias='alias',
        config_line=[],
        model='m',
        quant='q',
        build='b',
        port=port,
        ngl=None,
        profile_version_id=None,
        server_pid=server_pid,
        server_log='',
        interval=0.01,
        wait=30,
    )


def test_no_run_is_opened_when_the_new_server_exits_beside_an_orphan(monkeypatch, other_process_listener):
    """The orphan answers on the port, the new server could not bind and exited: nothing is recorded."""
    _, port = other_process_listener
    opened: list = []
    dead = subprocess.Popen([sys.executable, '-c', 'pass'])
    dead.wait()

    monkeypatch.setattr(rec, 'connect', lambda url: object())
    monkeypatch.setattr(rec, 'upsert_config', lambda *args, **kwargs: None)
    monkeypatch.setattr(rec, 'open_run', lambda *args, **kwargs: opened.append(kwargs) or 1)
    monkeypatch.setattr(rec.time, 'sleep', lambda seconds: None)

    assert rec.record(_args(port, server_pid=dead.pid)) == 0
    assert opened == []
