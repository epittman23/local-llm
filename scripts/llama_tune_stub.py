#!/usr/bin/env python3
"""A fake llama-server for exercising `llama-tune` without a GPU.

This is a fault injector, not a mock. The parts of `llama_tune.py` most likely
to be wrong are the ones that only run when something goes wrong -- a candidate
that will not load, a server that dies mid-visit, a card that drops to a tenth
of its throughput and stays there -- and none of those can be provoked on
demand from real hardware. So they are provoked here, deterministically, in
seconds rather than hours.

Two things this stub deliberately does *not* fake:

- **The database.** Every row a stub sweep writes is written by the real
  `llama_test.run_items` through the real `llama_db` writers, into a scratch
  `LLAMA_DB`. A stub that wrote its own rows would verify itself.
- **Correctness.** A planted pass answers with the benchmark's own reference
  solution and is graded by the benchmark's own harness. A planted failure
  answers with that same reference plus a module-level `raise`, so it fails for
  a reason the grader genuinely detects. The alternative -- telling the harness
  what the outcome was -- would leave the correctness guard untested, and the
  guard is the half of this feature that makes a claim about answers.

Throughput is a deterministic function of the candidate's overrides (read from
this process's own environment, exactly as llama-server would read its flags)
times seeded per-item noise, so there is a planted optimum for the search to
find and a reason for it to sometimes miss -- which is why the checks report a
recovery rate over many seeds rather than asserting a single run.

Configured by two files, both JSON, both named by environment variables:

  LLAMA_TUNE_STUB_CONFIG  the fault plan and the planted optimum (read only)
  LLAMA_TUNE_STUB_STATE   the cross-visit counters (read and written)

The state file is what makes "die on visit 3" and "drop to 12% from visit 5"
expressible at all: llama-tune launches a fresh server per visit, so anything
counted across visits has to outlive the process.

  LLAMA_TUNE_STUB_ITEMS   prompt sha -> {item, reference}, built by the checker

Usage (this is what LLAMA_TUNE_LAUNCH points at):

    python3 scripts/llama_tune_stub.py <profile>
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import random
import socketserver
import sys
import threading
import time

# Text a real llama-server prints when CUDA cannot find room. Matched by
# llama_tune.OOM_PATTERN, which is the point: the classification under test is
# the one that reads a log, so the stub has to write a log it would read.
OOM_TEXT = (
    "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096.00 MiB on "
    "device 0: cudaMalloc failed: out of memory\n"
    "llama_model_load: error loading model: unable to allocate CUDA0 buffer\n"
    "common_init_from_params: failed to load model\n")


def _json(path: str | None, default: dict) -> dict:
    if not path or not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)


class State:
    """Counters that outlive one visit, in a file, read-modify-write.

    No locking: llama-tune serves one candidate at a time by construction, and
    a stub that tolerated concurrent servers would be modelling a situation the
    tuner refuses to create (guard_port).
    """

    def __init__(self, path: str | None):
        self.path = path

    def read(self) -> dict:
        return _json(self.path, {"visits": 0, "capped_at": None})

    def write(self, data: dict) -> None:
        if self.path:
            with open(self.path, "w") as fh:
                json.dump(data, fh)


class Plan:
    """The fault plan, resolved against this visit's overrides and index."""

    def __init__(self, cfg: dict, overrides: dict, visit: int, state: dict):
        self.cfg = cfg
        self.overrides = overrides
        self.visit = visit
        self.state = state

    # -- what this visit's throughput should be ----------------------------
    def base_tps(self) -> float:
        """Planted optimum: one multiplicative gain per knob set correctly.

        Multiplicative rather than additive so no single knob can dominate the
        ranking on its own, which is what makes the refinement stage do work:
        an explore winner that got three of five knobs right is genuinely
        faster than the baseline and genuinely slower than the optimum.
        """
        tps = float(self.cfg.get("base_tps", 40.0))
        gain = float(self.cfg.get("gain", 0.08))
        for var, want in (self.cfg.get("optimum") or {}).items():
            if str(self.overrides.get(var, "")) == str(want):
                tps *= (1.0 + gain)
        return tps

    def capped(self) -> tuple[bool, dict]:
        """The 2026-09-05 shape: a drop that starts mid-sweep and may persist.

        `cap_seconds` null means it never recovers, which is what actually
        happened on this hardware and is the case the cooldown loop has to be
        bounded against.
        """
        state = dict(self.state)
        start = self.cfg.get("cap_from_visit")
        if start is None or self.visit < int(start):
            return False, state
        if state.get("capped_at") is None:
            state["capped_at"] = time.time()
        window = self.cfg.get("cap_seconds")
        if window is not None and time.time() - state["capped_at"] > float(window):
            return False, state
        return True, state

    def fault(self) -> str | None:
        """A load-time fault, if this visit is one of the planted ones."""
        for name in ("oom_visits", "load_error_visits", "hang_visits"):
            if self.visit in [int(v) for v in (self.cfg.get(name) or [])]:
                return name.rsplit("_", 1)[0]
        for var, val in (self.cfg.get("oom_overrides") or {}).items():
            if str(self.overrides.get(var, "")) == str(val):
                return "oom"
        return None

    def die_after(self) -> int | None:
        plan = self.cfg.get("die_after") or {}
        n = plan.get(str(self.visit))
        return int(n) if n is not None else None

    def cliff_after(self) -> int | None:
        """A within-visit request count after which this visit's own
        throughput craters, independent of the cross-visit cap.

        `capped()` is fixed for the whole life of one visit by construction
        (it is keyed on `self.visit`, which cannot change mid-process), so it
        cannot produce the 2026-09-05 shape -- a fall that starts *inside* a
        run -- which is exactly what CollapseWatch exists to catch. This gives
        that check something to catch.
        """
        plan = self.cfg.get("cliff_after") or {}
        n = plan.get(str(self.visit))
        return int(n) if n is not None else None

    def fails(self, item_id: str) -> bool:
        """Planted correctness, per candidate and per item.

        A regression is a *rate*, not a fixed set: a candidate that failed
        exactly the same items every time would make the paired comparison
        noiseless, and a guard verified only against a noiseless regression is
        not verified against anything this hardware would produce.
        """
        rate = float(self.cfg.get("base_fail_rate", 0.25))
        for rule in (self.cfg.get("regressions") or []):
            if all(str(self.overrides.get(k, "")) == str(v)
                   for k, v in (rule.get("when") or {}).items()):
                rate = float(rule.get("fail_rate", rate))
        seed = f"{item_id}|{json.dumps(self.overrides, sort_keys=True)}"
        digest = hashlib.sha1(seed.encode()).digest()
        return (int.from_bytes(digest[:4], "big") % 10_000) / 10_000.0 < rate


class Handler(http.server.BaseHTTPRequestHandler):
    plan: Plan
    items: dict
    cfg: dict
    served = 0
    lock = threading.Lock()

    def log_message(self, *_args) -> None:      # quiet; stdout is the load log
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/v1/models"):
            alias = os.environ.get("LLAMA_TUNE_STUB_ALIAS", "stub-model")
            self._send(200, {"object": "list",
                             "data": [{"id": alias, "object": "model"}]})
        elif self.path.startswith("/metrics"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"# stub\n")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self.path.startswith("/v1/chat/completions"):
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        prompt = ""
        for msg in body.get("messages") or []:
            if msg.get("role") == "user":
                prompt = msg.get("content") or ""

        with Handler.lock:
            Handler.served += 1
            n = Handler.served
        die = self.plan.die_after()
        if die is not None and n > die:
            # Not an error response: the server *goes away*, which is the case
            # llama_test.ServerGone exists for and the one that must never be
            # recorded as a model failure (2026-09-04, fourth).
            self.close_connection = True
            os._exit(137)

        key = hashlib.sha1(prompt.encode()).hexdigest()
        entry = self.items.get(key) or {}
        item_id = entry.get("item", key[:8])
        reference = entry.get("reference") or "pass"
        if self.plan.fails(item_id):
            reference += '\n\nraise AssertionError("planted regression")\n'
        content = f"```python\n{reference}\n```\n"

        capped, _ = self.plan.capped()
        cliff_at = self.plan.cliff_after()
        if cliff_at is not None and n > cliff_at:
            capped = True
        tps = self.plan.base_tps() * (0.12 if capped else 1.0)
        rng = random.Random(f"{item_id}|{n}|{self.cfg.get('seed', 0)}")
        tps *= 1.0 + rng.gauss(0.0, float(self.cfg.get("noise", 0.06)))
        tps = max(tps, 0.5)
        predicted_n = 120 + (int(hashlib.sha1(item_id.encode()).hexdigest()[:4], 16) % 240)
        prompt_n = 80 + (predicted_n % 60)
        pause = float(self.cfg.get("item_seconds", 0.0))
        if pause:
            time.sleep(pause)
        timings = {
            "prompt_n": prompt_n,
            "prompt_ms": prompt_n / 70.0 * 1000.0,
            "prompt_per_second": 70.0,
            "predicted_n": predicted_n,
            "predicted_ms": predicted_n / tps * 1000.0,
            "predicted_per_second": tps,
        }
        model = body.get("model", "stub-model")
        if body.get("stream"):
            # llama-tune's real visits ask for SSE (llama_test.py defaults
            # LLAMA_TEST_STREAM on), so a stub that only ever answered with a
            # single JSON body was silently untested by every round -- every
            # item graded no_code because _read_sse never saw a `data: ` line.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            chunk = {"id": f"stub-{n}", "object": "chat.completion.chunk",
                     "model": model,
                     "choices": [{"index": 0, "delta": {"role": "assistant",
                                                         "content": content}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            final = {"id": f"stub-{n}", "object": "chat.completion.chunk",
                      "model": model,
                      "choices": [{"index": 0, "delta": {},
                                   "finish_reason": "stop"}],
                      "timings": timings}
            self.wfile.write(f"data: {json.dumps(final)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self._send(200, {
            "id": f"stub-{n}", "object": "chat.completion",
            "model": model,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": content}}],
            "timings": timings,
        })


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def overrides_from_env() -> dict:
    """The candidate's flags, read the way llama-server reads them.

    llama-tune passes overrides as environment to `llama-serve`, so a stub that
    read them from anywhere else would be testing a different interface than
    the one production uses.
    """
    return {k: v for k, v in os.environ.items()
            if k.startswith("LLAMA_") and k not in
            ("LLAMA_PORT", "LLAMA_DB", "LLAMA_TUNE_STUB_CONFIG",
             "LLAMA_TUNE_STUB_STATE", "LLAMA_TUNE_STUB_ITEMS",
             "LLAMA_TUNE_STUB_ALIAS", "LLAMA_TUNE_LAUNCH",
             "LLAMA_TUNE_NVIDIA_SMI", "LLAMA_TEST_STREAM", "LLAMA_PLAIN",
             "LLAMA_VRAM_LOG")}


def main(argv: list[str]) -> int:
    cfg = _json(os.environ.get("LLAMA_TUNE_STUB_CONFIG"), {})
    items = _json(os.environ.get("LLAMA_TUNE_STUB_ITEMS"), {})
    state_file = State(os.environ.get("LLAMA_TUNE_STUB_STATE"))
    state = state_file.read()
    state["visits"] = int(state.get("visits", 0)) + 1
    visit = state["visits"]
    overrides = overrides_from_env()
    plan = Plan(cfg, overrides, visit, state)

    # The load log, on stdout, because that is where the classifier reads it.
    print(f"stub: visit {visit} profile {argv[0] if argv else '?'} "
          f"overrides {json.dumps(overrides, sort_keys=True)}", flush=True)

    fault = plan.fault()
    if fault == "oom":
        sys.stdout.write(OOM_TEXT)
        sys.stdout.flush()
        state_file.write(state)
        return 1
    if fault == "load_error":
        print("error loading model: tensor 'blk.0.attn_q.weight' not found",
              flush=True)
        state_file.write(state)
        return 1

    capped, state = plan.capped()
    state_file.write(state)

    port = int(os.environ.get("LLAMA_PORT") or 8090)
    Handler.plan, Handler.items, Handler.cfg = plan, items, cfg
    httpd = Server(("127.0.0.1", port), Handler)

    delay = float(cfg.get("load_seconds", 0.5))
    if fault == "hang":
        # Bound, not infinite: the assertion is that llama-tune gives up on its
        # own timeout, and a stub that never returned would hang the checker
        # too if that assertion ever regressed.
        delay = float(cfg.get("hang_seconds", 120.0))
    time.sleep(delay)
    print(f"stub: serving on {port} (capped={capped})", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
