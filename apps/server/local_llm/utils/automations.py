"""
Automation utilities and unified scheduler.

RRULE helpers, scheduler worker loop, and execution logic.
Follows the utils/<feature>.py pattern (cf. utils/channels.py, utils/task.py).

The scheduler_worker_loop handles all time-based background work:
  - Automation execution (claim_due → execute)
  - Calendar event alerts (upcoming events → socket + webhook notifications)
  - One-shot chat timers

Environment:
    SCHEDULER_POLL_INTERVAL             – seconds between polls (default: 10)
    TIMER_POLL_INTERVAL                 – seconds between timer polls (default: 1)
    CALENDAR_ALERT_LOOKAHEAD_MINUTES   – default alert window (default: 5)
"""

import asyncio
import datetime as dt
import itertools
import logging
import random
import re
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from dateutil.rrule import HOURLY, MINUTELY, SECONDLY, rruleset, rrulestr
from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials
from starlette.datastructures import Headers

from local_llm.constants import ERROR_MESSAGES
from local_llm.env import int_env
from local_llm.events import EVENTS, publish_event
from local_llm.internal.db import get_async_db
from local_llm.models.automations import AutomationModel, AutomationRuns, Automations
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.folders import Folders
from local_llm.models.messages import MessageForm
from local_llm.models.users import Users
from local_llm.utils.auth import create_token
from local_llm.utils.background import run_in_background
from local_llm.utils.misc import parse_duration
from local_llm.utils.task import prompt_template
from local_llm.utils.terminals import get_terminal_server_url

log = logging.getLogger(__name__)

_scheduler_poll_interval = int_env('SCHEDULER_POLL_INTERVAL', None)
SCHEDULER_POLL_INTERVAL = (
    _scheduler_poll_interval if _scheduler_poll_interval is not None else int_env('AUTOMATION_POLL_INTERVAL', 10)
)
TIMER_POLL_INTERVAL = int_env('TIMER_POLL_INTERVAL', 1)
CALENDAR_ALERT_LOOKAHEAD_MINUTES = int_env('CALENDAR_ALERT_LOOKAHEAD_MINUTES', 10)


####################
# RRULE Helpers
####################


def _resolve_tz(tz: str | None = None) -> ZoneInfo | None:
    """Safely resolve a timezone string to ZoneInfo.

    Returns None (→ server-local fallback) when *tz* is empty, None,
    or an unrecognised IANA key.  Logs a warning on bad keys so
    misconfiguration is visible in the server logs.
    """
    if not tz:
        return None
    try:
        return ZoneInfo(tz)
    except (KeyError, Exception):
        log.warning('Unknown timezone %r — falling back to server time', tz)
        return None


def _parse_rule(s: str, now: dt.datetime | None = None):
    """Parse RRULE with clock-aligned DTSTART for sub-daily frequencies.

    A SECONDLY/MINUTELY/HOURLY rule without a DTSTART starts from a fixed epoch
    (2000-01-01 00:00), so intervals snap to clock boundaries (every 5 min =
    :00, :05, :10). One with a DTSTART far in the past is moved forward by
    whole steps from it, keeping its phase and what is left of its COUNT
    (#267). A longer rule without a DTSTART starts at `now` (the user's clock)
    on the minute, so a time or day it does not state comes from there.
    """
    upper = s.upper()
    if 'EXRULE' in upper:
        raise ValueError('EXRULE is not supported in recurrence rules')

    parsed = rrulestr(s, ignoretz=True)
    rules = parsed._rrule if isinstance(parsed, rruleset) else [parsed]
    if len(rules) > 1:
        raise ValueError('only one RRULE is supported per recurrence rule')

    rule = rules[0]
    start = rule._dtstart.replace(tzinfo=None)
    anchor = now or dt.datetime.now()
    lines = s.splitlines()
    stripped = '\n'.join(line for line in lines if not line.upper().startswith('DTSTART')) or s
    has_dtstart = any(line.upper().startswith('DTSTART') for line in lines)
    step = {
        SECONDLY: dt.timedelta(seconds=rule._interval),
        MINUTELY: dt.timedelta(minutes=rule._interval),
        HOURLY: dt.timedelta(hours=rule._interval),
    }.get(rule._freq)

    if step is None:
        if not has_dtstart:
            # dateutil would start the rule at the server's local now; the
            # next run is asked for after the user's, so with the user
            # behind the server today's later runs were skipped. Start at the
            # user's now, on the minute, so an unset BYSECOND is 0 (#266).
            return rrulestr(stripped, dtstart=anchor.replace(second=0, microsecond=0), ignoretz=True)
        if not rule._dtstart.tzinfo:
            return parsed
        return rrulestr(stripped, dtstart=start, ignoretz=True)

    if rule._interval < 1:
        raise ValueError('RRULE INTERVAL must be a positive integer')
    if has_dtstart:
        steps = ((anchor - start) // step) if anchor > start else 0
        emitted = steps * len(rule._byminute or (0,)) * len(rule._bysecond or (0,))
        if emitted <= 100_000:
            return rrulestr(stripped, dtstart=start, ignoretz=True) if rule._dtstart.tzinfo else parsed
        # Too many steps to walk from DTSTART: move it forward by whole steps,
        # which keeps the rule's phase (every 5 minutes from 10:07 stays on
        # :07, :12, ...), as rebuilding it from an epoch-aligned start did not (#267).
        moved = start + steps * step
        count = getattr(rule, '_count', None)
        if not count:
            return rrulestr(stripped, dtstart=moved, ignoretz=True)
        left = count - steps
        if left > 0:
            recounted = _with_count(stripped, left)
        else:
            recounted = _with_count(stripped, 1)
        if re.search(r'\bBY', stripped, re.IGNORECASE) or recounted is None:
            # A filtered or expanded step is not one run each, so the runs left
            # cannot be counted (nor a COUNT that cannot be rewritten): keep
            # DTSTART. Exact, but the next run is found by walking every run
            # before it, at most COUNT, which can take seconds.
            return rrulestr(stripped, dtstart=start, ignoretz=True)
        # One run per step, `steps` of them before `moved`: what is left of
        # COUNT runs from there. A COUNT that ran out stays run out: its one
        # remaining run is at the original start, long past.
        return rrulestr(recounted, dtstart=moved if left > 0 else start, ignoretz=True)

    epoch = dt.datetime(2000, 1, 1)
    dtstart = epoch + ((anchor - epoch) // step) * step
    return rrulestr(stripped, dtstart=dtstart, ignoretz=True)


def _with_count(rule: str, count: int) -> str | None:
    """The rule with COUNT set to `count`, or None when it has not exactly one COUNT to set."""
    replaced, n = re.subn(r'COUNT=[+-]?\d+', f'COUNT={count}', rule, flags=re.IGNORECASE)
    return replaced if n == 1 else None


_DTSTART_VALUE = re.compile(r'[0-9]{8}(T[0-9]{6}Z?)?')


def _check_dates(s: str) -> None:
    """Raise ValueError for a DTSTART or UNTIL that is not a whole date or date-time, or any RDATE or EXDATE.

    dateutil reads `DTSTART:20261201T00` and `DTSTART:20261201T` as midnight,
    so an incomplete start time would run the automation at 00:00 (#642), and
    reads `UNTIL=` and the dates of `RDATE` and `EXDATE` as leniently (#789).
    The forms kept are RFC 5545's `YYYYMMDD`, `YYYYMMDDTHHMMSS` and the same
    with `Z`, with or without parameters such as `;TZID=Europe/Paris`. RDATE
    and EXDATE are refused, as nothing here writes them. The rule is read as
    `rrulestr` reads it: upper-cased (so `DT\ufb06ART` is `DTSTART` too) and
    split on any whitespace, so a part after a space on the same line is
    checked as well, and a part without a colon is an RRULE.
    """
    for part in s.upper().split():
        head, sep, value = part.partition(':')
        name = head.split(';')[0]
        if name in ('RDATE', 'EXDATE'):
            raise ValueError(f'{name} is not supported in recurrence rules')
        if name == 'DTSTART' and not (sep and _DTSTART_VALUE.fullmatch(value)):
            raise ValueError(f'DTSTART must be YYYYMMDD or YYYYMMDDTHHMMSS, optionally ending in Z; got {value!r}')
        if name != 'RRULE' and sep:
            continue
        for pair in (value if sep else head).split(';'):
            key, _, until = pair.partition('=')
            if key == 'UNTIL' and not _DTSTART_VALUE.fullmatch(until):
                raise ValueError(f'UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSS, optionally ending in Z; got {until!r}')


def validate_rrule(s: str, tz: str = None) -> None:
    """Raise ValueError if the RRULE is malformed or exhausted.

    When *tz* is provided the "now" reference uses the user's local
    clock so that near-future schedules are not incorrectly rejected
    on servers whose system clock is ahead (e.g. UTC vs US timezones).
    """
    upper = s.upper()
    if 'COUNT=' in upper and 'DTSTART' not in upper:
        raise ValueError(ERROR_MESSAGES.AUTOMATION_COUNT_REQUIRES_DTSTART)
    zi = _resolve_tz(tz)
    now = dt.datetime.now(zi).replace(tzinfo=None) if zi else dt.datetime.now()
    try:
        _check_dates(s)
        rule = _parse_rule(s, now)
    except Exception as e:
        raise ValueError(ERROR_MESSAGES.AUTOMATION_INVALID_RRULE(e))
    if rule.after(now) is None:
        raise ValueError(ERROR_MESSAGES.AUTOMATION_NO_FUTURE_RUNS)


_FREQ = re.compile(r'(?:^|[\s:;])FREQ=([A-Z]+)')


def _sub_daily(s: str) -> bool:
    """Whether the rule repeats more often than daily (SECONDLY, MINUTELY or HOURLY).

    A rule that does not parse raises here as `_parse_rule` would. The
    frequency is then read from the rule's own text, which dateutil has just
    accepted: its parsed rule keeps it only in a private attribute.
    """
    rrulestr(s, ignoretz=True)
    match = _FREQ.search(s.upper())
    return match is not None and match.group(1) in ('SECONDLY', 'MINUTELY', 'HOURLY')


def pin_rule_time(s: str, tz: str | None = None, now: dt.datetime | None = None) -> str:
    """The rule as it is saved: with a DTSTART at the user's minute when it takes its time from when it is read.

    A daily or longer rule that does not state both its hour and minute takes
    them from its anchor, which the scheduler sets to each run's due time
    (#512). A time the clocks skip is due at a later one, so the rule moved to
    that time for good (#670). Written down as a DTSTART when the rule is
    saved, the time is kept. A rule with its own DTSTART, a sub-daily one
    (aligned to its own grid) and one that states its hour and minute, as the
    schedule picker's do, are saved as given: the picker shows a rule with a
    DTSTART as custom text.
    """
    upper = s.upper()
    if 'DTSTART' in upper or _sub_daily(s) or ('BYHOUR=' in upper and 'BYMINUTE=' in upper):
        return s
    if now is None:
        zi = _resolve_tz(tz)
        now = dt.datetime.now(zi).replace(tzinfo=None) if zi else dt.datetime.now()
    return f'DTSTART:{now:%Y%m%dT%H%M}00\n{s}'


def next_run_ns(s: str, tz: str | None = None, anchor_ns: int | None = None) -> int | None:
    """Next occurrence as epoch nanoseconds, respecting user timezone.

    `anchor_ns` is when the rule is read from: a rule without DTSTART takes
    the time it does not state from there (now, by default). A claimed run
    passes its own due time, so a late claim does not move the rule's time
    of day (#512).
    """
    zi = _resolve_tz(tz)
    now = dt.datetime.now(zi) if zi else dt.datetime.now()
    now_naive = now.replace(tzinfo=None)
    anchor = now_naive
    # Only a daily or longer rule takes anything from its anchor; a shorter one
    # is aligned to its own grid, and anchoring it far back only made the walk
    # to now longer.
    if anchor_ns is not None and not _sub_daily(s):
        anchor = dt.datetime.fromtimestamp(anchor_ns / 1_000_000_000, tz=zi).replace(tzinfo=None)
    when = _parse_rule(s, anchor).after(now_naive)
    if when is None:
        return None
    if zi:
        when = when.replace(tzinfo=zi)
    return int(when.timestamp() * 1_000_000_000)


def next_n_runs_ns(s: str, n: int = 5, tz: str = None) -> list[int]:
    """Compute next N occurrences for UI preview.

    Uses the user's timezone for the starting "now" so that the
    preview matches the user's local clock (same as next_run_ns).
    """
    zi = _resolve_tz(tz)
    result = []
    now = dt.datetime.now(zi).replace(tzinfo=None) if zi else dt.datetime.now()
    rule = _parse_rule(s, now)
    # One walk for all n, rather than n walks from DTSTART (#267).
    for when in rule.xafter(now, count=n):
        if zi:
            dt_tz = when.replace(tzinfo=zi)
            result.append(int(dt_tz.timestamp() * 1_000_000_000))
        else:
            result.append(int(when.timestamp() * 1_000_000_000))
    return result


def runs_between_ns(
    s: str, anchor_ns: int, start_ns: int, end_ns: int, tz: str | None = None, limit: int = 5000
) -> list[int]:
    """The runs the rule makes in [start_ns, end_ns), as epoch nanoseconds, at most `limit`.

    The rule is read as the scheduler reads it (`_parse_rule`), anchored at
    `anchor_ns`, the automation's next run: a rule without DTSTART takes its
    unstated time from there, as the scheduler's did, and a COUNT counts from
    the rule's own DTSTART. The Scheduled Tasks calendar used to re-anchor
    the rule at the next run, so a COUNT started over there and it showed
    runs that never come (#356). A sub-daily rule, which takes nothing from
    its anchor but where to start walking, is read from the range's start
    when that is later, so a range far ahead is not reached by walking every
    run before it (#667).
    """
    if start_ns >= end_ns:
        return []
    zi = _resolve_tz(tz)

    def local(ns: int) -> dt.datetime:
        return dt.datetime.fromtimestamp(ns / 1_000_000_000, tz=zi).replace(tzinfo=None)

    # The scan runs in wall-clock time; starting a few hours early covers a DST change.
    scan_start = local(start_ns) - dt.timedelta(hours=3)
    anchor = local(anchor_ns)
    if _sub_daily(s):
        # `_parse_rule` moves a start more than 100,000 steps before the anchor
        # forward by whole steps, keeping its phase and what is left of its COUNT (#267).
        anchor = max(anchor, scan_start)
    rule = _parse_rule(s, anchor)
    runs: list[int] = []
    for when in rule.xafter(scan_start, inc=True):
        when_ns = int((when.replace(tzinfo=zi) if zi else when).timestamp() * 1_000_000_000)
        if when_ns >= end_ns or len(runs) >= limit:
            break
        # A wall-clock time the clocks skip lands on a later one, which the rule
        # then gives again: the scheduler runs that instant once.
        if when_ns >= start_ns and (not runs or when_ns > runs[-1]):
            runs.append(when_ns)
    return runs


def rrule_interval_seconds(s: str, sample: int = 50) -> int | None:
    """The shortest gap between consecutive occurrences, in seconds.

    None for a one-shot rule (COUNT=1) or one with fewer than two
    occurrences. The COUNT is read from the parsed rule: matching the text
    'COUNT=1' also matched COUNT=10, 100 and 1440 and waved every one of them
    through the minimum-interval checks. The gap is measured over the rule's
    own first `sample` occurrences rather than the next two after now, since a
    COUNT-bounded sub-daily rule's occurrences can all lie before now when it
    is parsed against the clock-aligned epoch start, and a rule such as
    BYHOUR=9,10 has a short gap that the first pair may not show.
    """
    parsed = rrulestr(s, ignoretz=True)
    rules = parsed._rrule if isinstance(parsed, rruleset) else [parsed]
    if not rules:
        return None
    if len(rules) > 1:
        raise ValueError('only one RRULE is supported per recurrence rule')
    rule = rules[0]
    if rule._count == 1:
        return None
    occurrences = list(itertools.islice(rule, sample))
    if len(occurrences) < 2:
        return None
    return int(min((b - a).total_seconds() for a, b in itertools.pairwise(occurrences)))


############################
# Worker Loop
############################


# Keep the old name as an alias so any stale imports still work.
async def automation_worker_loop(app) -> None:
    """Deprecated alias — use scheduler_worker_loop."""
    await scheduler_worker_loop(app)


async def _recover_stale_timers() -> None:
    """Timers left running by an error or a restart run again (#270); a failure here only logs."""
    try:
        from local_llm.utils.timers import recover_stale_timers

        await recover_stale_timers(int(time.time_ns()))
    except Exception:
        log.exception('Scheduler: timer recovery error')


async def scheduler_worker_loop(app) -> None:
    """Unified background scheduler for all time-based work.

    Handles:
      1. Automation execution  (ENABLE_AUTOMATIONS)
      2. Calendar event alerts (ENABLE_CALENDAR)

    Runs on every instance. Poll interval is configurable via
    SCHEDULER_POLL_INTERVAL env var (default: 10 seconds).
    """
    log.info(
        'Scheduler worker started (timer poll interval: %ss, scheduler poll interval: %ss)',
        TIMER_POLL_INTERVAL,
        SCHEDULER_POLL_INTERVAL,
    )
    next_scheduler_poll = 0.0

    while True:
        try:
            now = time.monotonic()
            # ── Timers ──
            try:
                from local_llm.utils.timers import claim_due_timers, execute_due_timer

                for timer_id, claim_id in await claim_due_timers(int(time.time_ns()), limit=10):
                    run_in_background(execute_due_timer(app, timer_id, claim_id))
            except Exception:
                log.exception('Scheduler: timer error')

            if now < next_scheduler_poll:
                await asyncio.sleep(max(1, TIMER_POLL_INTERVAL))
                continue
            # Jitter to spread automation/calendar load across instances; timers keep a tight poll.
            next_scheduler_poll = now + SCHEDULER_POLL_INTERVAL + random.uniform(0, 2)

            await _recover_stale_timers()

            # ── Automations ──
            if await Config.get('automations.enable'):
                try:
                    async with get_async_db() as db:
                        batch = await Automations.claim_due(int(time.time_ns()), limit=10, db=db)
                    if batch:
                        log.info('Claimed %s due automation(s)', len(batch))
                    for automation in batch:
                        run_in_background(execute_automation(app, automation))
                except Exception:
                    log.exception('Scheduler: automation error')

            # ── Calendar Alerts ──
            if await Config.get('calendar.enable'):
                try:
                    await _check_calendar_alerts(app)
                except Exception:
                    log.exception('Scheduler: calendar alert error')

        except Exception:
            log.exception('Scheduler worker error')

        await asyncio.sleep(max(1, TIMER_POLL_INTERVAL))


##########################
# Execute
####################


def _build_request(
    app,
    token: str | None = None,
) -> Request:
    """Build a minimal ASGI Request for chat_completion.

    Mirrors the mock-request pattern used in main.py lifespan
    (model pre-fetch, tool server init) for consistency.

    When token is provided, attach it as
    request.state.token so session-auth tool servers and terminals can
    authenticate headless scheduled runs as the automation owner.
    """
    scope = {
        'type': 'http',
        'asgi': {'version': '3.0', 'spec_version': '2.0'},
        'method': 'POST',
        'path': '/api/v1/automations/internal',
        'query_string': b'',
        'headers': Headers({}).raw,
        'client': ('127.0.0.1', 0),
        'server': ('127.0.0.1', 80),
        'scheme': 'http',
        'app': app,
    }
    request = Request(scope)
    # Ensure request.state is initialized with required attributes
    request.state.token = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token) if token else None
    request.state.enable_api_keys = False
    return request


async def _resolve_model_defaults(
    app, model_id: str, user=None, token: str | None = None
) -> tuple[list[str], dict, list[str], str | None]:
    models = getattr(app.state, 'MODELS', {}) or {}
    if model_id not in models:
        # The model list is loaded on a user's request (or a cache prefetch
        # that is off by default) and cleared on connection changes, so a run
        # the scheduler fires first after a restart found it empty and ran
        # without the model's tools, filters and features (#265).
        from local_llm.utils.models import get_all_models

        try:
            request = _build_request(app, token=token)
            await (get_all_models(request, user=user) if user else get_all_models(request))
        except Exception as e:
            log.warning('Automation: could not load models for %s: %s', model_id, e)
        models = getattr(app.state, 'MODELS', {}) or {}
    model = models.get(model_id, {})
    meta = model.get('info', {}).get('meta', {})

    tool_ids = list(meta.get('toolIds') or [])
    filter_ids = list(meta.get('defaultFilterIds') or [])
    terminal_id = meta.get('terminalId') or None
    default_feature_ids = meta.get('defaultFeatureIds', [])
    if not default_feature_ids:
        return tool_ids, {}, filter_ids, terminal_id

    capabilities = meta.get('capabilities') or {}
    features = {}

    # code_interpreter is excluded: it requires the frontend event emitter
    # and does not work in headless backend execution.
    feature_checks = {
        'web_search': await Config.get('web.search.enable'),
        'image_generation': await Config.get('image_generation.enable'),
    }

    for feature_id in default_feature_ids:
        if feature_id in feature_checks:
            # Feature must be: in defaultFeatureIds + capability enabled + admin enabled
            if capabilities.get(feature_id) and feature_checks[feature_id]:
                features[feature_id] = True

    return tool_ids, features, filter_ids, terminal_id


async def _set_terminal_cwd(app, server_id: str, user, cwd: str, chat_id: str) -> None:
    """Set the working directory on a terminal server via the proxy.

    Routes through the app's terminal proxy endpoint so that
    auth headers, orchestrator policy routing, and X-User-Id are
    handled correctly — same path the frontend uses.
    """
    import aiohttp

    from local_llm.env import AIOHTTP_CLIENT_SESSION_SSL

    connections = getattr(getattr(app, 'state', None), 'config', None)
    if connections is None:
        return
    connections = getattr(connections, 'TERMINAL_SERVER_CONNECTIONS', None) or []
    connection = next((c for c in connections if c.get('id') == server_id), None)
    if connection is None:
        log.warning(f'Terminal server {server_id} not found for CWD set')
        return

    base_url = get_terminal_server_url(connection)
    if not base_url:
        return

    target_url = f'{base_url}/files/cwd'

    headers = {'Content-Type': 'application/json', 'X-User-Id': user.id}
    if chat_id:
        headers['X-Session-Id'] = chat_id

    auth_type = connection.get('auth_type', 'bearer')
    if auth_type == 'bearer':
        headers['Authorization'] = f'Bearer {connection.get("key", "")}'

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.post(
                target_url,
                json={'path': cwd},
                headers=headers,
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    log.warning(f'Failed to set terminal CWD to {cwd}: HTTP {resp.status} — {body[:200]}')
    except Exception as e:
        log.warning(f'Failed to set terminal CWD: {e}')


async def _announce_run(app, user, automation: AutomationModel, chat_id: str) -> None:
    """Publish AUTOMATION_RUN_STARTED, once per run and before its reply is dispatched (#264).

    Both a scheduled and a manual run, into a chat or a channel, come through
    here, so the router publishes nothing itself.
    """
    await publish_event(
        app,
        EVENTS.AUTOMATION_RUN_STARTED,
        actor=user,
        subject_id=automation.id,
        data={'name': automation.name, 'chat_id': chat_id},
    )


async def _execute_channel_automation(
    app,
    automation: AutomationModel,
    user,
    prompt: str,
    model_id: str,
    token: str,
) -> None:
    target = automation.data.get('target') or {}
    channel_id = target.get('channel_id')
    if not channel_id or not await Config.get('channels.enable'):
        raise ValueError('Channel not found')

    # First, so the model list is loaded before the model's name is read.
    tool_ids, features, filter_ids, _ = await _resolve_model_defaults(app, model_id, user=user, token=token)
    model = getattr(app.state, 'MODELS', {}).get(model_id, {})
    request = _build_request(app, token=token)

    from local_llm.routers.channels import new_message_handler

    async with get_async_db() as db:
        user_message, channel = await new_message_handler(
            request,
            channel_id,
            MessageForm(
                content=prompt,
                data={},
                meta={'automation_id': automation.id},
            ),
            user,
            db,
        )
        response_parent_id = (
            user_message.parent_id
            if user_message.parent_id
            else (user_message.id if await Config.get('channels.model_response_mode', 'thread') == 'thread' else None)
        )
        assistant_message, channel = await new_message_handler(
            request,
            channel.id,
            MessageForm(
                parent_id=response_parent_id,
                content='',
                data={},
                meta={
                    'automation_id': automation.id,
                    'model_id': model_id,
                    'model_name': model.get('name', model_id),
                },
            ),
            user,
            db,
        )

    form_data = {
        'model': model_id,
        'messages': [
            {
                'role': 'system',
                'content': (
                    f'You are {model.get("name", model_id)}, participating in a channel conversation. Be concise and '
                    'conversational.'
                ),
            },
            {'role': 'user', 'content': f'{user.name if user else "User"}: {prompt}'},
        ],
        'stream': True,
        'chat_id': f'channel:{channel.id}',
        'id': assistant_message.id,
        'session_id': f'channel:{channel.id}',
        'automation_id': automation.id,
        'background_tasks': {},
    }
    if tool_ids:
        form_data['tool_ids'] = tool_ids
    if features:
        form_data['features'] = features
    if filter_ids:
        form_data['filter_ids'] = filter_ids

    await _announce_run(app, user, automation, f'channel:{channel.id}')
    await app.state.CHAT_COMPLETION_HANDLER(request, form_data, user=user)
    # Recorded before automation:result, on which the automation page refetches its runs.
    await _record_run(automation.id, 'success', chat_id=f'channel:{channel.id}')

    from local_llm.socket.main import sio

    await sio.emit(
        'automation:result',
        {
            'automation_id': automation.id,
            'name': automation.name,
            'chat_id': f'channel:{channel.id}',
            'message_id': assistant_message.id,
            'status': 'success',
        },
        room=f'user:{automation.user_id}',
    )
    await publish_event(
        app,
        EVENTS.AUTOMATION_RUN_COMPLETED,
        actor=user,
        subject_id=automation.id,
        data={'name': automation.name, 'channel_id': channel.id, 'message_id': assistant_message.id},
    )


async def execute_automation(app, automation: AutomationModel) -> None:
    """Execute an automation through the full chat completion pipeline.

    Creates a real chat or channel message, then calls chat_completion exactly like the frontend:
    session_id + chat_id + message_id → async task → pipeline handles everything
    (filters, model params, knowledge/RAG, tools, DB saves, webhooks).
    """
    try:
        user = await Users.get_user_by_id(automation.user_id)
        if not user:
            await _record_run(automation.id, 'error', error='User not found')
            await publish_event(
                app,
                EVENTS.AUTOMATION_RUN_FAILED,
                subject_id=automation.id,
                data={'name': automation.name, 'error': 'User not found'},
            )
            return

        # Re-gate the rehydrated owner: a demoted/deactivated or de-permissioned owner must not run.
        from local_llm.utils.access_control import has_permission

        if user.role not in ('user', 'admin') or (
            user.role != 'admin'
            and not await has_permission(user.id, 'features.automations', await Config.get('user.permissions'))
        ):
            error = 'Owner no longer permitted to run automations'
            await _record_run(automation.id, 'error', error=error)
            await publish_event(
                app,
                EVENTS.AUTOMATION_RUN_FAILED,
                actor=user,
                subject_id=automation.id,
                data={'name': automation.name, 'error': error},
            )
            return

        prompt = await prompt_template(automation.data['prompt'], user)
        model_id = automation.data['model_id']
        try:
            expires_delta = parse_duration(str(await Config.get('automations.auth_token_expires_in', '1h')))
        except ValueError:
            expires_delta = None
        token = create_token(
            data={'id': user.id, 'typ': 'automation'},
            expires_delta=expires_delta or dt.timedelta(hours=1),
        )

        target = automation.data.get('target') or {}
        if target.get('type') == 'channel':
            await _execute_channel_automation(app, automation, user, prompt, model_id, token)
            return

        folder_id = automation.folder_id
        if folder_id and not await Folders.get_folder_by_id_and_user_id(folder_id, automation.user_id):
            await Automations.clear_folder_ids(automation.user_id, [folder_id])
            folder_id = None

        # Generate proper UUIDs for messages (same as frontend)
        user_msg_id = str(uuid4())
        assistant_msg_id = str(uuid4())

        chat_id = str(uuid4())
        chat = await Chats.insert_new_chat(
            chat_id,
            automation.user_id,
            ChatForm(
                folder_id=folder_id,
                chat={
                    'title': automation.name,
                    'models': [model_id],
                    'history': {
                        'currentId': assistant_msg_id,
                        'messages': {
                            user_msg_id: {
                                'id': user_msg_id,
                                'parentId': None,
                                'role': 'user',
                                'content': prompt,
                                'childrenIds': [assistant_msg_id],
                                'timestamp': int(time.time()),
                                'models': [model_id],
                            },
                            assistant_msg_id: {
                                'id': assistant_msg_id,
                                'parentId': user_msg_id,
                                'role': 'assistant',
                                'content': '',
                                'done': False,
                                'model': model_id,
                                'childrenIds': [],
                                'timestamp': int(time.time()),
                            },
                        },
                    },
                    'messages': [
                        {'role': 'user', 'content': prompt},
                    ],
                    'meta': {'automation_id': automation.id},
                },
            ),
        )

        if not chat:
            error = 'Failed to create chat'
            await _record_run(automation.id, 'error', error=error)
            await publish_event(
                app,
                EVENTS.AUTOMATION_RUN_FAILED,
                actor=user,
                subject_id=automation.id,
                data={'name': automation.name, 'error': error},
            )
            return

        # Notify frontend to refresh chat list
        from local_llm.socket.main import sio

        await sio.emit(
            'events',
            {
                'chat_id': chat.id,
                'message_id': user_msg_id,
                'data': {'type': 'chat:list'},
            },
            room=f'user:{automation.user_id}',
        )

        # Resolve model defaults (frontend does this, backend doesn't)
        tool_ids, features, filter_ids, terminal_id = await _resolve_model_defaults(
            app, model_id, user=user, token=token
        )

        # Build the same payload the frontend sends to /api/chat/completions
        form_data = {
            'model': model_id,
            'messages': [{'role': 'user', 'content': prompt}],
            'stream': True,
            'chat_id': chat.id,
            'id': assistant_msg_id,
            'parent_id': None,  # Root message (chat already created above)
            'user_message': {
                'id': user_msg_id,
                'parentId': None,
                'role': 'user',
                'content': prompt,
            },
            'session_id': f'automation:{automation.id}',
            'automation_id': automation.id,
            'background_tasks': {},
        }
        if tool_ids:
            form_data['tool_ids'] = tool_ids
        if features:
            form_data['features'] = features
        if filter_ids:
            form_data['filter_ids'] = filter_ids
        if terminal_id:
            form_data['terminal_id'] = terminal_id

        # Call the full chat completion pipeline (same as POST /api/chat/completions).
        # The handler reference is stored on app.state to avoid circular imports.
        # It returns once the reply is dispatched to background tasks, so the
        # run's outcome is recorded only once they end: a model or provider
        # failure then reaches the run history (#264). This runs in the
        # background itself, so waiting holds up no other automation.
        # Started before the dispatch, so a reply that fails at once still
        # reads started, then failed. A manual run is announced here too.
        await _announce_run(app, user, automation, chat.id)
        request = _build_request(app, token=token)
        response = await app.state.CHAT_COMPLETION_HANDLER(request, form_data, user=user)
        run = {'automation_id': automation.id, 'chat_id': chat.id, 'message_id': assistant_msg_id}
        try:
            reason = await _wait_for_reply(response)
        except asyncio.CancelledError:
            # The backend is stopping (a --reload restart or a shutdown):
            # the run still gets its row and its FAILED event.
            await asyncio.shield(finish_automation_run(app, user, run, error=REPLY_INTERRUPTED))
            raise
        if reason == REPLY_INTERRUPTED:
            # Shutdown is under way: recorded under shield, as above.
            await asyncio.shield(finish_automation_run(app, user, run, error=reason))
        else:
            await finish_automation_run(app, user, run, error=reason)

    except Exception as e:
        log.exception(f'Automation {automation.id} failed')
        error = str(e)[:4000]
        await _record_run(automation.id, 'error', error=error)
        await publish_event(
            app,
            EVENTS.AUTOMATION_RUN_FAILED,
            subject_id=automation.id,
            data={'name': automation.name, 'error': error},
        )


####################
# Internals
####################


_LEGACY_ALERT_LEAD_NS = 60 * 60 * 1_000_000_000


def already_alerted(meta: dict | None, start_at: int) -> bool:
    """Whether the occurrence starting at `start_at` (ns) was already alerted (#183)."""
    if not meta:
        return False
    alerted_for = meta.get('alerted_for')
    if isinstance(alerted_for, int):
        return alerted_for == start_at
    # Rows alerted before alerted_for existed carry only alerted_at, the time
    # of the alert. It belongs to this occurrence only if it came within the
    # longest lead there was then, an hour; an earlier one was for another
    # start. Leads are longer now (#184), but no such row has one.
    alerted_at = meta.get('alerted_at')
    return (
        isinstance(alerted_at, int)
        and start_at - _LEGACY_ALERT_LEAD_NS <= alerted_at <= start_at + _LEGACY_ALERT_LEAD_NS
    )


async def _check_calendar_alerts(app) -> None:
    """Check for upcoming calendar events and send alert notifications.

    De-duplication is DB-backed via meta.alerted_for, the start of the
    occurrence last alerted, so it survives restarts and works across
    instances. A moved event, and each occurrence of a recurring one, has a
    start it was not alerted for, so it alerts again (#183).
    """
    from local_llm.models.calendar import CalendarEvents, CalendarEventUpdateForm
    from local_llm.socket.main import sio

    now_ns = int(time.time_ns())
    default_lookahead_ns = CALENDAR_ALERT_LOOKAHEAD_MINUTES * 60 * 1_000_000_000
    # Grace window covers one poll cycle + jitter so "At time of event"
    # alerts (alert_minutes=0) are not missed.
    grace_ns = (SCHEDULER_POLL_INTERVAL + 5) * 1_000_000_000

    async with get_async_db() as db:
        upcoming = await CalendarEvents.get_upcoming_events(now_ns, default_lookahead_ns, grace_ns=grace_ns, db=db)

    if not upcoming:
        return

    for event, _user_tz in upcoming:
        if already_alerted(event.meta, event.start_at):
            continue

        # Compute minutes until event starts
        minutes_until = max(0, int((event.start_at - now_ns) / (60 * 1_000_000_000)))

        alert_data = {
            'event_id': event.id,
            'title': event.title,
            'description': event.description or '',
            'start_at': event.start_at,
            'minutes_until': minutes_until,
            'calendar_id': event.calendar_id,
            'location': event.location or '',
        }

        await sio.emit(
            'events',
            {
                'data': {
                    'type': 'calendar:alert',
                    'data': alert_data,
                },
            },
            room=f'user:{event.user_id}',
        )

        # Mark as alerted in DB so it survives restarts / multi-instance
        try:
            await CalendarEvents.update_event_by_id(
                event.id,
                CalendarEventUpdateForm(meta={'alerted_at': now_ns, 'alerted_for': event.start_at}),
            )
        except Exception:
            log.debug('Failed to mark event %s as alerted', event.id, exc_info=True)

        # Send target notification if user has one configured
        try:
            time_str = f'in {minutes_until} min' if minutes_until > 0 else 'now'
            await publish_event(
                app,
                EVENTS.CALENDAR_ALERT,
                subject_id=event.id,
                subject_type='calendar.event',
                source='scheduler',
                data={
                    **alert_data,
                    'user_id': event.user_id,
                    'starts_in': time_str,
                    'message': f'{event.title}: starting {time_str}',
                },
                message=event.title,
            )
        except Exception:
            log.debug('Failed to send notification for calendar alert %s', event.id, exc_info=True)


# How long a run waits for its reply before recording it as unfinished. Long
# enough for a thinking model on slow local hardware; the reply itself is not
# stopped, only no longer waited for.
REPLY_WAIT_SECONDS = 30 * 60
REPLY_STOPPED = 'The reply was stopped'
REPLY_INTERRUPTED = 'The backend stopped before the reply finished'


async def _wait_for_reply(response, wait_seconds: float = REPLY_WAIT_SECONDS) -> str | None:
    """Wait for the background tasks a chat completion dispatched to end.

    Returns why the run failed when the wait itself says so: a task was
    cancelled (someone pressed Stop) or the reply outlasted the wait.
    Otherwise None, and the stored message tells the outcome: the reply's
    own task saves its errors there. A task no longer registered has ended.
    """
    from local_llm.tasks import tasks as running

    task_ids = response.get('task_ids') if isinstance(response, dict) else None
    pending = [running[t] for t in task_ids or [] if t in running]
    if not pending:
        return None
    done, still_running = await asyncio.wait(pending, timeout=wait_seconds)
    if still_running:
        return f'The reply did not finish within {round(wait_seconds)} s'
    if any(task.cancelled() for task in done):
        # Shutdown cancels running replies too (#362); that is not a Stop.
        from local_llm import tasks as registry

        return REPLY_INTERRUPTED if registry.stopping else REPLY_STOPPED
    return None


def _error_text(stored) -> str:
    """Readable text for an error saved on a message: {'content': str | provider dict} or a bare value."""
    content = stored.get('content') if isinstance(stored, dict) else stored
    if isinstance(content, dict):
        content = content.get('message') or content.get('detail') or content.get('error') or content
    return str(content)[:4000] if content else 'The reply failed'


async def _reply_error(chat_id: str, message_id: str) -> str | None:
    """Why a stored reply failed, or None if it finished without an error."""
    message = await Chats.get_message_by_id_and_message_id(chat_id, message_id)
    if message is None:
        return 'The reply was not found'
    if message.get('error'):
        return _error_text(message['error'])
    if not message.get('done'):
        return 'The reply did not finish'
    return None


async def finish_automation_run(app, user, metadata: dict, error: str | None = None) -> None:
    """Record how an automation's reply ended, once it has (#264).

    Unless the caller already knows the error, the stored message says: the
    reply's task saves its error there, whether the request failed or a
    provider error arrived inside the stream (which does not raise); a reply
    that is missing or not done did not finish. The run is recorded before
    automation:result is emitted, so the page that refetches on it sees the
    row. An automation deleted meanwhile gets no row. Never raises:
    recording the outcome must not fail the run.
    """
    automation_id = metadata.get('automation_id')
    if not automation_id:
        return
    chat_id = metadata.get('chat_id')
    try:
        if error is None and chat_id and metadata.get('message_id'):
            error = await _reply_error(chat_id, metadata['message_id'])
    except Exception:
        log.exception('could not read the reply of automation %s', automation_id)
        error = 'The reply could not be read'
    try:
        automation = await Automations.get_by_id(automation_id)
        if automation is None:
            return
        name = automation.name
    except Exception:
        log.exception('could not look up automation %s', automation_id)
        name = ''
    status = 'error' if error else 'success'
    try:
        await _record_run(automation_id, status, chat_id=chat_id, error=error)
    except Exception:
        log.exception('could not record the run of automation %s', automation_id)
    try:
        from local_llm.socket.main import sio

        await sio.emit(
            'automation:result',
            {'automation_id': automation_id, 'name': name, 'chat_id': chat_id, 'status': status},
            room=f'user:{user.id}',
        )
        await publish_event(
            app,
            EVENTS.AUTOMATION_RUN_FAILED if error else EVENTS.AUTOMATION_RUN_COMPLETED,
            actor=user,
            subject_id=automation_id,
            data={'name': name, 'chat_id': chat_id, **({'error': error} if error else {})},
        )
    except Exception:
        log.exception('could not announce the outcome of automation %s', automation_id)


async def _record_run(
    automation_id: str,
    status: str,
    chat_id: str | None = None,
    error: str | None = None,
):
    """Insert a run record into automation_run."""
    async with get_async_db() as db:
        await AutomationRuns.insert(automation_id, status, chat_id=chat_id, error=error, db=db)
