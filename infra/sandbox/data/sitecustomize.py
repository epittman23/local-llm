# The sandbox's package telemetry hook for Python (docs/guides/sandbox.md,
# "Package telemetry"). Dockerfile.data installs it as the conda Python's
# sitecustomize, so every Python process in the sandbox imports it at start.
#
# At exit it records one line per distribution the process imported (the
# top-level names in sys.modules, the standard library dropped, mapped with
# importlib.metadata.packages_distributions()); an uncaught
# ModuleNotFoundError records the missing module. Lines are JSON, appended to
# EVENTS, which the backend reads and empties after each call
# (apps/server/local_llm/sandbox/telemetry.py, which checks every field).
#
# It must never change what a program does: everything is inside
# `try/except Exception: pass`, the previous excepthook still runs, and
# nothing is printed. It is advisory: code in the sandbox can remove or
# forge it, and a process killed (a timeout, the OOM killer, os._exit)
# records nothing.
# apps/server/tests/test_sandbox_telemetry.py runs this file in a subprocess
# with the EVENTS line below pointed at a temporary directory.
EVENTS = '/workspace/.telemetry/events.jsonl'


def _lllm_telemetry():
    import atexit
    import sys

    def record(events):
        import json
        import os

        os.makedirs(os.path.dirname(EVENTS), mode=0o700, exist_ok=True)
        with open(EVENTS, 'a', encoding='utf-8') as handle:
            handle.write(''.join(json.dumps(event, separators=(',', ':')) + '\n' for event in events))

    def distributions_by_module():
        # importlib.metadata.packages_distributions() reads every installed
        # distribution's metadata (half a second for a few hundred), so its
        # answer is kept beside the events, keyed by the site directories and
        # their modification times: an install or removal changes them.
        import json
        import os
        from importlib import metadata

        cache = os.path.join(os.path.dirname(EVENTS), 'distributions.json')
        key = []
        for entry in sys.path:
            if entry.endswith(('site-packages', 'dist-packages')):
                try:
                    key.append([entry, os.stat(entry).st_mtime_ns])
                except OSError:
                    pass
        try:
            with open(cache, encoding='utf-8') as handle:
                kept = json.load(handle)
            if kept['key'] == key and isinstance(kept['map'], dict):
                return kept['map']
        except Exception:
            pass
        mapping = metadata.packages_distributions()
        try:
            os.makedirs(os.path.dirname(cache), mode=0o700, exist_ok=True)
            partial = f'{cache}.{os.getpid()}'
            with open(partial, 'w', encoding='utf-8') as handle:
                json.dump({'key': key, 'map': mapping}, handle)
            os.replace(partial, cache)
        except Exception:
            pass
        return mapping

    def at_exit():
        try:
            import time
            from importlib import metadata

            stdlib = sys.stdlib_module_names
            names = {name.partition('.')[0] for name in list(sys.modules)}
            mapping = distributions_by_module()
            distributions = set()
            for name in names:
                if name and name not in stdlib:
                    distributions.update(mapping.get(name, ()))
            now = int(time.time())
            events = []
            for distribution in sorted(distributions)[:500]:
                try:
                    version = metadata.version(distribution)
                except Exception:
                    version = None
                events.append({'kind': 'import', 'name': distribution, 'version': version, 'ts': now})
            if events:
                record(events)
        except Exception:
            pass

    previous = sys.excepthook

    def excepthook(kind, value, traceback):
        try:
            name = getattr(value, 'name', None)
            top = name.partition('.')[0] if isinstance(name, str) else ''
            # A missing submodule of a package that imported is not a missing package.
            if issubclass(kind, ModuleNotFoundError) and top and top not in sys.modules:
                import time

                record([{'kind': 'module_miss', 'name': top, 'ts': int(time.time())}])
        except Exception:
            pass
        previous(kind, value, traceback)

    atexit.register(at_exit)
    sys.excepthook = excepthook


try:
    _lllm_telemetry()
except Exception:
    pass
