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

describe('clearing a field of an existing event (#158)', () => {
	it('sends null, so the update removes it rather than keeping the old value', () => {
		const old = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 10), {
			rrule: 'FREQ=WEEKLY',
			description: 'Agenda',
			location: 'Room 4'
		});
		const f = { ...eventFields(old, '', null), repeat: '', description: ' ', location: '', endDate: '' };
		const out = eventPayload(f, old);
		expect('form' in out && out.form).toMatchObject({
			rrule: null,
			description: null,
			location: null,
			end_at: null
		});
	});
	it('a repeat rule the menu cannot show is kept through an edit', () => {
		const biweekly = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 10), { rrule: 'FREQ=WEEKLY;INTERVAL=2' });
		const renamed = eventPayload({ ...eventFields(biweekly, '', null), title: 'Renamed' }, biweekly);
		expect('form' in renamed && renamed.form.rrule).toBeUndefined();
		// Also from one of its occurrences, which saves the series at its own start.
		const occurrence = {
			...biweekly,
			start_at: ns(at(2026, 8, 15, 9)),
			end_at: ns(at(2026, 8, 15, 10)),
			instance_id: 'x'
		};
		const out = eventPayload(
			{ ...eventFields(occurrence, '', null), title: 'Renamed' },
			occurrence,
			ns(at(2026, 8, 1, 9))
		);
		expect('form' in out && out.form).toMatchObject({ rrule: undefined, start_at: ns(at(2026, 8, 1, 9)) });
	});
	it('clearing Repeat on an occurrence makes it one event at that occurrence', () => {
		const daily = ev(at(2026, 8, 20, 9), at(2026, 8, 20, 10), { rrule: 'FREQ=DAILY', instance_id: 'x' });
		const out = eventPayload({ ...eventFields(daily, '', null), repeat: '' }, daily, ns(at(2026, 8, 1, 9)));
		expect('form' in out && out.form).toMatchObject({ rrule: null, start_at: ns(at(2026, 8, 20, 9)) });
	});
	it('a new event leaves blank fields out', () => {
		const f = { ...eventFields(null, 'cal', ns(at(2026, 8, 1, 9))), title: 'x', endDate: '' };
		const out = eventPayload(f, null);
		const form = 'form' in out ? out.form : {};
		for (const key of ['rrule', 'description', 'location', 'end_at'])
			expect((form as Record<string, unknown>)[key]).toBeUndefined();
	});
});

describe('editing one occurrence of a repeating event', () => {
	// A daily series that began 1 Oct, opened from its 20 Oct occurrence.
	const seriesStart = ns(at(2026, 9, 1, 9));
	const occurrence = ev(at(2026, 9, 20, 9), at(2026, 9, 20, 9, 30), {
		id: 's1',
		rrule: 'FREQ=DAILY',
		instance_id: `s1_${ns(at(2026, 9, 20, 9))}`
	});

	it('a rename keeps the series start (#318)', () => {
		const f = { ...eventFields(occurrence, '', null), title: 'Renamed' };
		const out = eventPayload(f, occurrence, seriesStart);
		expect('form' in out && out.form).toMatchObject({
			title: 'Renamed',
			start_at: seriesStart,
			end_at: ns(at(2026, 9, 1, 9, 30)),
			rrule: 'FREQ=DAILY'
		});
	});
	it('a new time moves every occurrence by the same amount', () => {
		const f = { ...eventFields(occurrence, '', null), startTime: '10:00', endTime: '11:00' };
		const out = eventPayload(f, occurrence, seriesStart);
		expect('form' in out && out.form).toMatchObject({
			start_at: ns(at(2026, 9, 1, 10)),
			end_at: ns(at(2026, 9, 1, 11))
		});
	});
	it('a new date moves the series by as many days, at the same local time across a DST change', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'America/New_York';
		try {
			// Series from 1 Oct 09:00 (EDT), opened at 3 Nov (EST), moved back to 30 Oct.
			const start = ns(at(2026, 9, 1, 9));
			const nov3 = ev(at(2026, 10, 3, 9), at(2026, 10, 3, 10), { id: 's2', rrule: 'FREQ=DAILY', instance_id: 'x' });
			const f = { ...eventFields(nov3, '', null), startDate: '2026-10-30', endDate: '2026-10-30' };
			const out = eventPayload(f, nov3, start);
			const got = 'form' in out ? new Date(out.form.start_at / NS) : null;
			expect([got?.getMonth(), got?.getDate(), got?.getHours()]).toEqual([8, 27, 9]);
			const allDay = eventPayload({ ...f, allDay: true }, { ...nov3, all_day: true }, start);
			const [s, e] = 'form' in allDay ? [allDay.form.start_at, allDay.form.end_at ?? 0] : [0, 0];
			expect([new Date(s / NS).getDate(), new Date(s / NS).getHours()]).toEqual([27, 0]);
			expect([new Date(e / NS).getDate(), new Date(e / NS).getHours()]).toEqual([27, 23]);
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});
	it('a changed repeat rule starts at the occurrence being edited', () => {
		const f = { ...eventFields(occurrence, '', null), repeat: 'weekly' };
		const out = eventPayload(f, occurrence, seriesStart);
		expect('form' in out && out.form).toMatchObject({ start_at: ns(at(2026, 9, 20, 9)), rrule: 'FREQ=WEEKLY' });
	});
	it('a stored event (no occurrence) is saved as the form says', () => {
		const stored = { ...occurrence, instance_id: undefined };
		const out = eventPayload(eventFields(stored, '', null), stored, seriesStart);
		expect('form' in out && out.form.start_at).toBe(ns(at(2026, 9, 20, 9)));
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
	it("a shared calendar's default flag is its owner's, not the user's (#182)", () => {
		const theirs = { id: 'theirs', is_default: true, user_id: 'other' };
		expect(defaultCalendarId([theirs, { id: 'mine', is_default: true, user_id: 'me' }], 'me')).toBe('mine');
		expect(defaultCalendarId([theirs, { id: 'mine', is_default: false, user_id: 'me' }], 'me')).toBe('mine');
		expect(defaultCalendarId([theirs], 'me')).toBe('theirs');
	});
	it('an automation run opens its chat, else the automation', () => {
		expect(automationTarget(ev(at(2026, 8, 1), undefined, { meta: { automation_id: 'a1', chat_id: 'c9' } }))).toBe(
			'/c/c9'
		);
		expect(automationTarget(ev(at(2026, 8, 1), undefined, { meta: { automation_id: 'a1' } }))).toBe('/automations/a1');
		expect(automationTarget(ev(at(2026, 8, 1)))).toBeNull();
	});
	it("a channel automation's run opens its channel, not /c/channel:<id> (#320)", () => {
		expect(
			automationTarget(ev(at(2026, 8, 1), undefined, { meta: { automation_id: 'a1', chat_id: 'channel:ch1' } }))
		).toBe('/channels/ch1');
	});
});
