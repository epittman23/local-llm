"""A moved event alerts again, and each occurrence of a recurring one alerts (#183).

An alert stored `meta.alerted_at` on the event row, which updates merge and
nothing cleared, and the poll skipped any event that had it, so a moved
event never alerted again. The poll also selected rows by their own
`start_at`, so a recurring series alerted only for its first occurrence.
An alert now records the occurrence it was for (`alerted_for`), and the
poll expands recurring series into the occurrences in its window. These
run against the test run's migrated database, with the socket and the
notification target faked.

Run from apps/server:

    python -m pytest tests/test_calendar_alert_rearm.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time
import uuid
from zoneinfo import ZoneInfo

from local_llm.models.calendar import CalendarEventForm, CalendarEvents, CalendarEventUpdateForm, Calendars
from local_llm.models.users import Users
from local_llm.socket import main as socket_main
from local_llm.utils import automations

MIN = 60 * 1_000_000_000
HOUR = 60 * MIN
DAY = 24 * HOUR


def _run(coro):
    return asyncio.run(coro)


def _user_calendar() -> tuple[str, str]:
    uid = f'alerts-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    # Expansion runs in the owner's zone; a fixed one keeps the test off DST.
    _run(Users.update_user_by_id(uid, {'timezone': 'UTC'}))
    calendars = _run(Calendars.get_or_create_defaults(uid))
    return uid, calendars[0].id


def _event(uid: str, calendar_id: str, start_at: int, **extra):
    form = CalendarEventForm(
        calendar_id=calendar_id, title='Standup', start_at=start_at, meta={'alert_minutes': 10}, **extra
    )
    return _run(CalendarEvents.insert_new_event(uid, form))


def _sessions(monkeypatch, connected: bool = True) -> None:
    """Whether the user has a socket session; the alerts are held when not (#520)."""
    monkeypatch.setattr(socket_main, 'get_session_ids_by_user_id', lambda user_id: ['sid'] if connected else [])


def _poll(monkeypatch, connected: bool = True) -> list[dict]:
    sent: list[dict] = []
    _sessions(monkeypatch, connected)

    async def emit(name, payload, room=None):
        sent.append(payload['data']['data'])

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(socket_main.sio, 'emit', emit)
    monkeypatch.setattr(automations, 'publish_event', nothing)
    _run(automations._check_calendar_alerts(None))
    return sent


def test_a_moved_event_alerts_again(monkeypatch):
    uid, cal = _user_calendar()
    start = time.time_ns() + 5 * MIN
    event = _event(uid, cal, start)

    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 1
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 0  # not twice

    # Moved to a few minutes later: a start it was not alerted for.
    _run(CalendarEvents.update_event_by_id(event.id, CalendarEventUpdateForm(start_at=start + 2 * MIN)))
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 1


def test_a_recurring_event_alerts_for_a_later_occurrence(monkeypatch):
    uid, cal = _user_calendar()
    # A daily series that began two days ago; its next occurrence is in 5 minutes.
    first = (time.time_ns() // 1_000_000_000) * 1_000_000_000 + 5 * MIN - 2 * DAY  # whole seconds, as stored
    event = _event(uid, cal, first, end_at=first + 15 * MIN, rrule='FREQ=DAILY')

    alerts = [a for a in _poll(monkeypatch) if a['event_id'] == event.id]

    assert len(alerts) == 1
    assert alerts[0]['start_at'] == first + 2 * DAY
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 0


def test_an_alert_from_before_this_change_still_counts_for_its_occurrence():
    start = time.time_ns() + 5 * MIN
    # The old format: only the time of the alert.
    assert automations.already_alerted({'alerted_at': start - 10 * MIN}, start)
    assert not automations.already_alerted({'alerted_at': start - DAY}, start)
    assert automations.already_alerted({'alerted_for': start}, start)
    assert not automations.already_alerted({'alerted_for': start - DAY}, start)
    assert not automations.already_alerted(None, start)


def test_a_recurring_all_day_series_does_not_remind_every_evening(monkeypatch):
    uid, cal = _user_calendar()
    first = (time.time_ns() // 1_000_000_000) * 1_000_000_000 + 5 * MIN - 2 * DAY
    event = _event(uid, cal, first, all_day=True, rrule='FREQ=DAILY')

    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 0


def test_the_repeated_hour_on_the_night_clocks_go_back_is_found():
    """The expander compares local clock times; the window must still find the occurrence."""
    from local_llm.models.calendar import CalendarEventModel

    # America/New_York, 2026-11-01: 01:00-02:00 happens twice. A daily 01:45 series,
    # polled ten minutes before its 01:45 EDT occurrence (05:45 UTC). The window's
    # end, an hour later, is 01:35 EST on the clock: before 01:45.
    occurrence = 1793511900 * 1_000_000_000
    model = CalendarEventModel.model_validate(
        {
            'id': 'e',
            'calendar_id': 'c',
            'user_id': 'u',
            'title': 't',
            'start_at': occurrence - 3 * DAY,
            'end_at': occurrence - 3 * DAY + 15 * MIN,
            'all_day': False,
            'rrule': 'FREQ=DAILY',
            'is_cancelled': False,
            'meta': {'alert_minutes': 10},
            'created_at': 0,
            'updated_at': 0,
        }
    )
    now = occurrence - 10 * MIN
    found = CalendarEvents._occurrences_in(model, now, now + HOUR, 'America/New_York')
    assert occurrence in [o.start_at for o in found]


def _event_with_lead(uid: str, calendar_id: str, start_at: int, minutes: int):
    form = CalendarEventForm(calendar_id=calendar_id, title='Talk', start_at=start_at, meta={'alert_minutes': minutes})
    return _run(CalendarEvents.insert_new_event(uid, form))


def _alerted(monkeypatch, event) -> int:
    return [a['event_id'] for a in _poll(monkeypatch)].count(event.id)


def test_a_reminder_longer_than_an_hour_fires_that_long_before(monkeypatch):
    """#184: the poll fetched only events within the next hour, so a 2-hour reminder came an hour before."""
    uid, cal = _user_calendar()
    event = _event_with_lead(uid, cal, time.time_ns() + 90 * MIN, 120)

    assert _alerted(monkeypatch, event) == 1
    # Within its own lead, not the old one-hour window: not alerted again.
    assert _alerted(monkeypatch, event) == 0


def test_a_reminder_does_not_fire_before_its_lead(monkeypatch):
    uid, cal = _user_calendar()
    event = _event_with_lead(uid, cal, time.time_ns() + 90 * MIN, 60)

    assert _alerted(monkeypatch, event) == 0


def test_a_reminder_longer_than_22_hours_fires_22_hours_before(monkeypatch):
    uid, cal = _user_calendar()
    soon = _event_with_lead(uid, cal, time.time_ns() + 21 * HOUR, 3 * 24 * 60)
    later = _event_with_lead(uid, cal, time.time_ns() + 23 * HOUR, 3 * 24 * 60)

    sent = [a['event_id'] for a in _poll(monkeypatch)]
    assert sent.count(soon.id) == 1
    assert sent.count(later.id) == 0


def _daily(tz: str, first: int, minutes: int):
    uid = f'alerts-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    _run(Users.update_user_by_id(uid, {'timezone': tz}))
    cal = _run(Calendars.get_or_create_defaults(uid))[0].id
    form = CalendarEventForm(
        calendar_id=cal, title='Daily', start_at=first, rrule='FREQ=DAILY', meta={'alert_minutes': minutes}
    )
    return _run(CalendarEvents.insert_new_event(uid, form))


def _alerts_at(monkeypatch, event, times: list[int]) -> list[int]:
    """The occurrence starts alerted for `event` by a poll at each of `times`."""
    starts: list[int] = []
    clock = [0]

    async def emit(name, payload, room=None):
        if payload['data']['data']['event_id'] == event.id:
            starts.append(payload['data']['data']['start_at'])

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(socket_main.sio, 'emit', emit)
    monkeypatch.setattr(automations, 'publish_event', nothing)
    monkeypatch.setattr(time, 'time_ns', lambda: clock[0])
    _sessions(monkeypatch)
    for t in times:
        clock[0] = t
        _run(automations._check_calendar_alerts(None))
    return starts


def test_a_daily_series_with_a_day_long_reminder_alerts_each_occurrence_once(monkeypatch):
    """#184: with a lead of a day, two occurrences of a daily series were due at once, and alerted in turn."""
    start = int(dt.datetime(2030, 6, 10, 9, tzinfo=dt.UTC).timestamp()) * 1_000_000_000
    event = _daily('UTC', start - 3 * DAY, 3 * 24 * 60)
    polls = [start - DAY + 2 * 1_000_000_000] + [start + (1 + 11 * k) * 1_000_000_000 for k in range(6)]

    starts = _alerts_at(monkeypatch, event, polls)

    assert len(starts) == len(set(starts))


def test_a_daily_series_over_the_spring_forward_night_alerts_once(monkeypatch):
    """Occurrences 23 hours apart: a lead over 22 hours had both due, and alerted every poll for an hour."""
    ny = ZoneInfo('America/New_York')
    first = int(dt.datetime(2027, 3, 10, 9, tzinfo=ny).timestamp()) * 1_000_000_000
    saturday = int(dt.datetime(2027, 3, 13, 9, tzinfo=ny).timestamp()) * 1_000_000_000
    event = _daily('America/New_York', first, 1440)
    polls = [saturday - 70 * MIN + k * 10 * 1_000_000_000 for k in range(420)]

    starts = _alerts_at(monkeypatch, event, polls)

    assert len(starts) == len(set(starts))


def _event_at(uid: str, calendar_id: str, start_at: int, end_at: int | None, **extra):
    form = CalendarEventForm(
        calendar_id=calendar_id, title='Talk', start_at=start_at, end_at=end_at, meta={'alert_minutes': 10}, **extra
    )
    return _run(CalendarEvents.insert_new_event(uid, form))


def test_a_reminder_with_no_session_is_held_and_delivered_when_one_connects(monkeypatch):
    """#520: it was marked sent though nobody received it."""
    uid, cal = _user_calendar()
    event = _event_at(uid, cal, time.time_ns() + 5 * MIN, time.time_ns() + 65 * MIN)

    assert _poll(monkeypatch, connected=False) == []
    assert _poll(monkeypatch, connected=False) == []  # still held
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 1
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 0  # once


def test_a_held_reminder_is_still_delivered_after_the_event_has_started(monkeypatch):
    uid, cal = _user_calendar()
    event = _event_at(uid, cal, time.time_ns() - 20 * MIN, time.time_ns() + 40 * MIN)

    assert _poll(monkeypatch, connected=False) == []
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 1


def test_a_reminder_is_dropped_once_the_event_has_ended_and_not_retried(monkeypatch):
    uid, cal = _user_calendar()
    start = time.time_ns() - 2 * MIN
    event = _event_at(uid, cal, start, time.time_ns() - 1_000_000_000)

    # Ended a second ago: still fetched (inside the poll's grace), so dropped and marked.
    assert _poll(monkeypatch, connected=False) == []
    stored = _run(CalendarEvents.get_event_by_id(event.id))
    assert automations.already_alerted(stored.meta, stored.start_at)
    # A session connecting afterwards gets nothing.
    assert _poll(monkeypatch) == []


def test_a_moment_event_with_no_session_is_dropped_after_its_start(monkeypatch):
    uid, cal = _user_calendar()
    event = _event_at(uid, cal, time.time_ns() + 1_000_000_000, None)
    assert _poll(monkeypatch, connected=False) == []  # not ended yet: held

    clock = time.time_ns() + 2_000_000_000
    monkeypatch.setattr(time, 'time_ns', lambda: clock)
    assert _poll(monkeypatch, connected=False) == []  # ended: dropped
    stored = _run(CalendarEvents.get_event_by_id(event.id))
    assert automations.already_alerted(stored.meta, stored.start_at)


def test_an_all_day_event_with_no_end_is_held_through_its_day(monkeypatch):
    uid, cal = _user_calendar()
    event = _event_at(uid, cal, time.time_ns() - 3 * HOUR, None, all_day=True)

    assert _poll(monkeypatch, connected=False) == []
    assert [a['event_id'] for a in _poll(monkeypatch)].count(event.id) == 1


def test_a_notification_target_counts_as_delivery(monkeypatch):
    from local_llm.utils import notifications

    uid, cal = _user_calendar()
    event = _event_at(uid, cal, time.time_ns() + 5 * MIN, time.time_ns() + 65 * MIN)

    async def target(user_id, event_name):
        return True

    monkeypatch.setattr(notifications, 'has_notification_target', target)
    published: list[str] = []

    async def record(app, name, **kwargs):
        published.append(kwargs['subject_id'])

    monkeypatch.setattr(automations, 'publish_event', record)
    _sessions(monkeypatch, connected=False)

    async def emit(*args, **kwargs):
        return None

    monkeypatch.setattr(socket_main.sio, 'emit', emit)
    _run(automations._check_calendar_alerts(None))
    _run(automations._check_calendar_alerts(None))

    assert published == [event.id]
