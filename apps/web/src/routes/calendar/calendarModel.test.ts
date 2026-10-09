import { describe, expect, it } from 'vitest';
import {
	NS,
	automationTarget,
	defaultCalendarId,
	eventFields,
	eventPayload,
	eventsByDay,
	eventsInHour,
	formatHour,
	headerText,
	monthGrid,
	repeatFromRrule,
	stepDate,
	visibleRange,
	weekDays
} from './calendarModel';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min);
const ns = (d: Date) => d.getTime() * NS;
const ev = (start: Date, end?: Date, extra = {}) =>
	({
		id: String(start.getTime()),
		calendar_id: 'c',
		start_at: ns(start),
		end_at: end ? ns(end) : null,
		all_day: false,
		title: 't',
		meta: null,
		rrule: null,
		...extra
	}) as any;

describe('grids and ranges', () => {
	it('a month grid is six weeks from the Sunday on or before the 1st', () => {
		const g = monthGrid(at(2026, 8, 15)); // September 2026 starts on a Tuesday
		expect(g).toHaveLength(42);
		expect(g[0].toDateString()).toBe(at(2026, 7, 30).toDateString());
		expect(g[0].getDay()).toBe(0);
	});
	it('a week runs Sunday to Saturday at local midnight', () => {
		const w = weekDays(at(2026, 8, 17, 15));
		expect(w[0].toDateString()).toBe(at(2026, 8, 13).toDateString());
		expect(w[0].getHours()).toBe(0);
		expect(w).toHaveLength(7);
	});
	it('the fetch window covers the grid, the week, or the day', () => {
		expect(visibleRange('month', at(2026, 8, 15))).toEqual({
			start: at(2026, 7, 30).toISOString(),
			end: at(2026, 9, 11).toISOString()
		});
		expect(visibleRange('day', at(2026, 8, 15, 13))).toEqual({
			start: at(2026, 8, 15).toISOString(),
			end: at(2026, 8, 16).toISOString()
		});
	});
	it('stepping a month from the 31st lands in the next month', () => {
		expect(stepDate('month', at(2026, 0, 31), 1).getMonth()).toBe(1);
		expect(stepDate('week', at(2026, 0, 31), -1).getDate()).toBe(24);
	});
	it('headers and hour labels', () => {
		expect(headerText('month', at(2026, 8, 27))).toBe('September 2026');
		expect(headerText('day', at(2026, 8, 27))).toBe('Sun, September 27, 2026');
		expect([0, 9, 12, 15].map(formatHour)).toEqual(['12 AM', '9 AM', '12 PM', '3 PM']);
	});
});

describe('placing events', () => {
	it('an event is under every day it touches', () => {
		const e = ev(at(2026, 8, 1, 22), at(2026, 8, 3, 1));
		const map = eventsByDay([e]);
		expect(Object.keys(map)).toHaveLength(3);
		expect(map[String(at(2026, 8, 2).getTime())]).toEqual([e]);
	});
	it('an event with no end is on its start day only; hours count starts only', () => {
		const e = ev(at(2026, 8, 1, 9, 30));
		expect(Object.keys(eventsByDay([e]))).toEqual([String(at(2026, 8, 1).getTime())]);
		expect(eventsInHour([e], at(2026, 8, 1), 9)).toEqual([e]);
		expect(eventsInHour([e], at(2026, 8, 1), 10)).toEqual([]);
	});
});

describe('event form', () => {
	it('a new event is one hour from the clicked time', () => {
		const f = eventFields(null, 'cal', ns(at(2026, 8, 1, 9)));
		expect(f).toMatchObject({
			calendarId: 'cal',
			startDate: '2026-09-01',
			startTime: '09:00',
			endDate: '2026-09-01',
			endTime: '10:00',
			alertMinutes: 10,
			repeat: ''
		});
	});
	it('an edited event reads its repeat rule, unknown rules as none', () => {
		expect(repeatFromRrule('freq=weekly; byday=MO,TU,WE,TH,FR')).toBe('weekdays');
		expect(repeatFromRrule('FREQ=WEEKLY;INTERVAL=2')).toBe('');
		expect(eventFields(ev(at(2026, 8, 1, 9), undefined, { rrule: 'FREQ=DAILY' }), '', null)).toMatchObject({
			repeat: 'daily',
			endDate: ''
		});
	});
	it('needs a title; all-day spans the day; blanks are left out', () => {
		const f = eventFields(null, 'cal', ns(at(2026, 8, 1, 9)));
		expect(eventPayload(f, null)).toEqual({ error: 'Title is required' });
		const out = eventPayload({ ...f, title: ' Standup ', allDay: true, repeat: 'weekly' }, null);
		expect('form' in out && out.form).toMatchObject({
			title: 'Standup',
			start_at: ns(at(2026, 8, 1)),
			end_at: ns(at(2026, 8, 1, 23, 59)),
			rrule: 'FREQ=WEEKLY',
			description: undefined,
			location: undefined
		});
	});
	it('an end before the start keeps the old length (or zero for a new event)', () => {
		const old = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 11));
		const f = { ...eventFields(old, '', null), startDate: '2026-09-05' };
		const out = eventPayload(f, old);
		expect('form' in out && (out.form.end_at! - out.form.start_at) / NS).toBe(2 * 3_600_000);
		const fresh = eventPayload({ ...f, title: 'x' }, null);
		expect('form' in fresh && fresh.form.end_at).toBe('form' in fresh ? fresh.form.start_at : 0);
	});
});

describe('calendars and automations', () => {
	it('new events go to the default calendar, never the scheduled-tasks one', () => {
		expect(
			defaultCalendarId([
				{ id: 'a', is_default: false },
				{ id: 'b', is_default: true }
			])
		).toBe('b');
		expect(
			defaultCalendarId([
				{ id: '__scheduled_tasks__', is_default: false },
				{ id: 'a', is_default: false }
			])
		).toBe('a');
		expect(defaultCalendarId([])).toBe('');
	});
	it('an automation run opens its chat, else the automation', () => {
		expect(automationTarget(ev(at(2026, 8, 1), undefined, { meta: { automation_id: 'a1', chat_id: 'c9' } }))).toBe(
			'/c/c9'
		);
		expect(automationTarget(ev(at(2026, 8, 1), undefined, { meta: { automation_id: 'a1' } }))).toBe('/automations/a1');
		expect(automationTarget(ev(at(2026, 8, 1)))).toBeNull();
	});
});
