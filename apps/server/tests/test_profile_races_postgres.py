"""Racing profile writes on a real Postgres: the default is never archived, and a lost race is a conflict (#152).

test_profile_concurrency.py shows the guards are in the SQL; this shows what
Postgres does with them. On a freshly migrated database, one session makes a
change and holds its transaction open while the app's own method runs in a
second session; the method's UPDATE then waits on the row lock, and re-checks
its WHERE against the committed row once the first session commits:

- a profile made the default meanwhile is refused by archive;
- a profile archived meanwhile is refused by set_default, which keeps the
  old default;
- a set_default racing another one is a ProfileConflict, with one default left.

Needs TEST_DATABASE_URL (a throwaway Postgres), like test_schema_drift.py,
whose fresh_database fixture it uses; CI provides one.

Run from apps/server:

    TEST_DATABASE_URL=postgresql://... python -m pytest tests/test_profile_races_postgres.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# The fixture is reused, so its skip stays in one place.
from test_schema_drift import fresh_database

__all__ = ['fresh_database']

SERVER_DIR = Path(__file__).resolve().parents[1]

RACES = r"""
import asyncio, json
import local_llm.config  # runs the migrations on DATABASE_URL
from sqlalchemy import select, update
from local_llm.benchmarks.serving.profiles import ProfileConflict, ProfileError
from local_llm.internal.db import get_async_db
from local_llm.models.benchmarks.profiles import BenchmarkProfile, BenchmarkProfiles

DEFINITION = {
    'arch': 'dense', 'alias': 'race', 'model_path': '{LLAMA_MODELS}/race/x.gguf',
    'ctx': 4096, 'threads': 4, 'ngl': 0,
}


clear_default = update(BenchmarkProfile).filter(BenchmarkProfile.is_default.is_(True)).values(is_default=False)


async def make(name):
    entry = await BenchmarkProfiles.create(name=name, display_name=name, definition=DEFINITION)
    return entry.profile.profile_id


async def default_name():
    entry = await BenchmarkProfiles.get_default()
    return entry.profile.name if entry else None


async def archived(profile_id):
    async with get_async_db() as db:
        row = (await db.execute(select(BenchmarkProfile).filter_by(profile_id=profile_id))).scalars().first()
        return row.archived_at is not None


async def while_held(change, method):
    # `change` runs in a transaction held open while `method` starts; `method`
    # must wait for it, so it is still pending when the change commits.
    async with get_async_db() as held:
        await change(held)
        task = asyncio.create_task(method())
        await asyncio.sleep(1.0)
        pending = not task.done()
        await held.commit()
    try:
        await asyncio.wait_for(task, 30)
        return pending, None
    except ProfileError as e:
        return pending, f'{type(e).__name__}: {e}'


async def main():
    out = {}
    a, b, c, d = [await make(f'race_{n}') for n in 'abcd']
    await BenchmarkProfiles.set_default(a)

    # 1. b is made the default while archive(b) runs.
    async def make_b_default(db):
        await db.execute(clear_default)
        await db.execute(update(BenchmarkProfile).filter_by(profile_id=b).values(is_default=True))
    out['archive'] = await while_held(make_b_default, lambda: BenchmarkProfiles.archive(b))
    out['archive_after'] = [await default_name(), await archived(b)]

    # 2. c is archived while set_default(c) runs.
    async def archive_c(db):
        await db.execute(update(BenchmarkProfile).filter_by(profile_id=c).values(archived_at=1_800_000_000))
    out['set_default'] = await while_held(archive_c, lambda: BenchmarkProfiles.set_default(c))
    out['set_default_after'] = [await default_name(), await archived(c)]

    # 3. a is made the default while set_default(d) runs.
    async def make_a_default(db):
        await db.execute(clear_default)
        await db.execute(update(BenchmarkProfile).filter_by(profile_id=a).values(is_default=True))
    out['two_defaults'] = await while_held(make_a_default, lambda: BenchmarkProfiles.set_default(d))
    async with get_async_db() as db:
        rows = (await db.execute(select(BenchmarkProfile.name).filter(BenchmarkProfile.is_default.is_(True)))).all()
    out['defaults_after'] = sorted(r[0] for r in rows)
    print('RACES ' + json.dumps(out))


asyncio.run(main())
"""


def test_racing_profile_writes_on_postgres(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    result = subprocess.run(
        [sys.executable, '-c', RACES], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('RACES '))
    races = json.loads(line.removeprefix('RACES '))

    # Each method waited for the held change, then was refused by it.
    assert races['archive'] == [True, 'ProfileError: the default profile cannot be archived; set another default first']
    assert races['archive_after'] == ['race_b', False]
    assert races['set_default'] == [True, 'ProfileError: an archived profile cannot be the default']
    assert races['set_default_after'] == ['race_b', True]
    assert races['two_defaults'][0] is True
    assert races['two_defaults'][1].startswith('ProfileConflict: another profile was made the default')
    assert races['defaults_after'] == ['race_a']
