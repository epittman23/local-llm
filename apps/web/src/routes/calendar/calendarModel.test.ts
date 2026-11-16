import { describe, expect, it } from 'vitest';
import {
	automationTarget,
	bandItems,
	calendarColour,
	dayItems,
	defaultCalendarId,
	eventFields,
	eventPayload,
	eventProblems,
	eventsByDay,
	firstFreeColour,
	formatHour,
	HIDDEN_KEY,
	headerText,
	isSpanning,
	layoutDay,
	localeWeekStart,
	monthGrid,
	NS,
	nextHalfHour,
	readHidden,
	reminderOptions,
	repeatFromRrule,
	stepDate,
	timeRange,
	visibleRange,
	weekBars,
	weekDays,
	withStart,
	writeHidden
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
const items = (events: Parameters<typeof dayItems>[0] | undefined) => dayItems(events ?? []);

describe('grids and ranges', () => {
	it('a month grid is six weeks from the first day of the week on or before the 1st', () => {
		const g = monthGrid(at(2026, 8, 15)); // September 2026 starts on a Tuesday
		expect(g).toHaveLength(42);
		expect(g[0].toDateString()).toBe(at(2026, 7, 30).toDateString());
		expect(g[0].getDay()).toBe(0);
		// From Monday (S6-D12): 31 August.
		expect(monthGrid(at(2026, 8, 15), 1)[0].toDateString()).toBe(at(2026, 7, 31).toDateString());
		// November 2026 starts on a Sunday: a Monday week starts on 26 October.
		expect(monthGrid(at(2026, 10, 1), 1)[0].toDateString()).toBe(at(2026, 9, 26).toDateString());
	});
	it('a week runs from its first day at local midnight', () => {
		const w = weekDays(at(2026, 8, 17, 15));
		expect(w[0].toDateString()).toBe(at(2026, 8, 13).toDateString());
		expect(w[0].getHours()).toBe(0);
		expect(w).toHaveLength(7);
		expect(weekDays(at(2026, 8, 13), 1)[0].toDateString()).toBe(at(2026, 8, 7).toDateString());
	});
	it('the fetch window covers the grid, the week, or the day', () => {
		expect(visibleRange('month', at(2026, 8, 15))).toEqual({
			start: at(2026, 7, 30).toISOString(),
			end: at(2026, 9, 11).toISOString()
		});
		expect(visibleRange('week', at(2026, 8, 17), 1)).toEqual({
			start: at(2026, 8, 14).toISOString(),
			end: at(2026, 8, 21).toISOString()
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
	it('headers, hour labels and times in the locale’s own format (#1107)', () => {
		expect(headerText('month', at(2026, 8, 27))).toBe('September 2026');
		expect(headerText('day', at(2026, 8, 27))).toBe('Sunday, September 27, 2026');
		expect(headerText('day', at(2026, 8, 27), true)).toBe('Sun, Sep 27, 2026');
		expect([0, 9, 12, 15].map(formatHour).map((h) => h.replace(/\s/, ' '))).toEqual(['12 AM', '9 AM', '12 PM', '3 PM']);
		// "9:00 AM" keeps its space.
		expect(timeRange(ev(at(2026, 8, 1, 9), at(2026, 8, 1, 11)))).toMatch(/^9:00\sAM – 11:00\sAM$/);
		expect(timeRange(ev(at(2026, 8, 1, 9)))).toMatch(/^9:00\sAM$/);
	});
	it('the week starts where the locale says (S6-D12)', () => {
		expect(localeWeekStart('en-US')).toBe(0);
		expect(localeWeekStart('en-GB')).toBe(1);
		expect(localeWeekStart('de-DE')).toBe(1);
		expect(localeWeekStart('not a locale!')).toBe(0);
	});
});

describe('placing events', () => {
	it('an event is under every day it touches', () => {
		const e = ev(at(2026, 8, 1, 22), at(2026, 8, 3, 1));
		const map = eventsByDay([e]);
		expect(Object.keys(map)).toHaveLength(3);
		expect(map[String(at(2026, 8, 2).getTime())]).toEqual([e]);
	});
	it('an event with no end is on its start day only, and drawn at least the least height', () => {
		const e = ev(at(2026, 8, 1, 9, 30));
		expect(Object.keys(eventsByDay([e]))).toEqual([String(at(2026, 8, 1).getTime())]);
		expect(layoutDay([e], at(2026, 8, 1), 30)).toMatchObject([{ top: 570, height: 30, col: 0, cols: 1 }]);
		expect(layoutDay([e], at(2026, 8, 2), 30)).toEqual([]);
	});
	it('an event that ends at or before its start is on its start day only', () => {
		for (const end of [at(2026, 8, 1, 22), at(2026, 8, 1, 21)]) {
			const e = ev(at(2026, 8, 1, 22), end);
			expect(Object.keys(eventsByDay([e]))).toEqual([String(at(2026, 8, 1).getTime())]);
		}
	});
	it('an occurrence carried over from the day before is in the band', () => {
		const e = ev(at(2026, 8, 1, 23), at(2026, 8, 2, 1), { rrule: 'FREQ=DAILY', instance_id: 'x_1' });
		expect(
			bandItems(items(eventsByDay([e])[String(at(2026, 8, 2).getTime())]), at(2026, 8, 2)).map((i) => i.event)
		).toEqual([e]);
	});
	it('an event that ends at midnight is not on the next day', () => {
		const e = ev(at(2026, 8, 1, 22), at(2026, 8, 2));
		expect(Object.keys(eventsByDay([e]))).toEqual([String(at(2026, 8, 1).getTime())]);
	});
	// Day and week grids (#319): the grid holds timed events that start on the
	// day; the band above the hours holds all-day events, and timed events
	// carried over from an earlier day, on every day they touch.
	it('an all-day event is in the band on every day, never in the grid', () => {
		const e = ev(at(2026, 9, 19), at(2026, 9, 21, 23, 59), { all_day: true });
		const byDay = eventsByDay([e]);
		for (const d of [19, 20, 21])
			expect(bandItems(items(byDay[String(at(2026, 9, d).getTime())]), at(2026, 9, d)).map((i) => i.event)).toEqual([
				e
			]);
		expect(byDay[String(at(2026, 9, 22).getTime())]).toBeUndefined();
		expect(layoutDay([e], at(2026, 9, 19), 30)).toEqual([]);
	});
	it('the grid places events on the local clock across a DST change (#321)', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'America/New_York';
		try {
			// 8 Mar 2026, spring forward: 2 AM is skipped, so a 03:30 event is at 3:30 on the grid.
			const spring = ev(new Date(Date.UTC(2026, 2, 8, 7, 30)));
			expect(layoutDay([spring], at(2026, 2, 8), 30)).toMatchObject([{ top: 210 }]);
			// 1 Nov 2026, fall back: 1 AM happens twice, and both 01:30s are at 1:30, side by side.
			const first = ev(new Date(Date.UTC(2026, 10, 1, 5, 30)));
			const second = ev(new Date(Date.UTC(2026, 10, 1, 6, 30)), undefined, { id: 'second' });
			expect(layoutDay([first, second], at(2026, 10, 1), 30)).toMatchObject([
				{ top: 90, col: 0, cols: 2 },
				{ top: 90, col: 1, cols: 2 }
			]);
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});
	it('a timed event is in the grid on its first day, then in the band on later days', () => {
		const e = ev(at(2026, 9, 19, 22), at(2026, 9, 21, 10));
		const byDay = eventsByDay([e]);
		const band = (d: number) =>
			bandItems(items(byDay[String(at(2026, 9, d).getTime())]), at(2026, 9, d)).map((i) => i.event);
		// It runs past midnight, so the grid stops it at the day's end.
		expect(layoutDay([e], at(2026, 9, 19), 30)).toMatchObject([{ top: 22 * 60, height: 120 }]);
		expect(band(19)).toEqual([]);
		expect(band(20)).toEqual([e]);
		expect(band(21)).toEqual([e]);
	});
	it('overlapping events share the width in columns; a free column is reused (#937)', () => {
		const a = ev(at(2026, 9, 19, 9), at(2026, 9, 19, 11), { id: 'a' });
		const b = ev(at(2026, 9, 19, 9, 30), at(2026, 9, 19, 10, 30), { id: 'b' });
		const c = ev(at(2026, 9, 19, 10, 45), at(2026, 9, 19, 12), { id: 'c' });
		const d = ev(at(2026, 9, 19, 14), at(2026, 9, 19, 15), { id: 'd' });
		const placed = Object.fromEntries(layoutDay([c, d, b, a], at(2026, 9, 19), 30).map((p) => [p.event.id, p]));
		expect(placed.a).toMatchObject({ col: 0, cols: 2, top: 540, height: 120 });
		expect(placed.b).toMatchObject({ col: 1, cols: 2 });
		expect(placed.c).toMatchObject({ col: 1, cols: 2 });
		expect(placed.d).toMatchObject({ col: 0, cols: 1 });
		// A short event at the end of the day is drawn up from midnight.
		expect(layoutDay([ev(at(2026, 9, 19, 23, 50))], at(2026, 9, 19), 30)).toMatchObject([{ top: 1410, height: 30 }]);
	});
});

describe('what a day shows (#936)', () => {
	const run = (h: number, auto: string, extra = {}) =>
		ev(at(2026, 9, 19, h), undefined, { id: `r${auto}${h}`, title: auto, meta: { automation_id: auto }, ...extra });
	it('lists your own events first, all-day ones first, then each automation’s runs collapsed', () => {
		const own = ev(at(2026, 9, 19, 15), at(2026, 9, 19, 16), { id: 'own' });
		const allDay = ev(at(2026, 9, 19), at(2026, 9, 19, 23, 59), { id: 'allday', all_day: true });
		const list = dayItems([run(1, 'hourly'), run(2, 'hourly'), run(3, 'daily'), own, allDay, run(0, 'hourly')]);
		expect(list.map((i) => [i.kind, i.event.id, i.kind === 'runs' ? i.count : 1])).toEqual([
			['event', 'allday', 1],
			['event', 'own', 1],
			['runs', 'rhourly0', 3],
			['event', 'rdaily3', 1]
		]);
	});
	it('collapsed runs go in the band; a single run keeps its time in the grid', () => {
		const list = dayItems([run(1, 'hourly'), run(2, 'hourly'), run(3, 'daily')]);
		expect(bandItems(list, at(2026, 9, 19)).map((i) => i.key)).toEqual(['runs-hourly']);
	});
});

describe('month bars (#1107)', () => {
	const week = weekDays(at(2026, 10, 24));
	it('draws all-day and multi-day events once across their days, each in the first free lane', () => {
		const conf = ev(at(2026, 10, 24), at(2026, 10, 26, 23, 59), { id: 'conf', all_day: true });
		const trip = ev(at(2026, 10, 20, 18), at(2026, 10, 23, 9), { id: 'trip' });
		const late = ev(at(2026, 10, 26), at(2026, 11, 2), { id: 'late', all_day: true });
		const day = ev(at(2026, 10, 25, 9), at(2026, 10, 25, 10), { id: 'day' });
		expect(isSpanning(day)).toBe(false);
		expect(isSpanning(trip)).toBe(true);
		const bars = weekBars([conf, trip, late, day], week);
		expect(bars.map((b) => [b.event.id, b.lane, b.from, b.span, b.startsBefore, b.endsAfter])).toEqual([
			['trip', 0, 0, 2, true, false],
			['conf', 0, 2, 3, false, false],
			['late', 1, 4, 3, false, true]
		]);
		expect(weekBars([ev(at(2026, 9, 1), at(2026, 9, 2), { all_day: true })], week)).toEqual([]);
	});
});

describe('calendar colours and what is hidden (#1106, S6-D9, S6-D10)', () => {
	const presets = ['#82c7f0', '#e4c062', '#e492c9', '#83d494', '#eb9a75', '#b5a4ea'];
	it('the Automations calendar is drawn in --series-6; a calendar without a colour in --series-1', () => {
		expect(calendarColour({ id: '__scheduled_tasks__', color: '#8b5cf6' })).toBe('var(--series-6)');
		expect(calendarColour({ id: 'p', color: null })).toBe('var(--series-1)');
		expect(calendarColour({ id: 'w', color: '#ef4444' })).toBe('#ef4444');
	});
	it('a new calendar starts on the first preset unlike any calendar’s colour', () => {
		// Personal's stored blue is close to the first preset's.
		expect(firstFreeColour(presets, [{ id: 'p', color: '#3b82f6' }])).toBe('#e4c062');
		expect(
			firstFreeColour(presets, [
				{ id: 'p', color: null },
				{ id: 'y', color: '#E4C062' }
			])
		).toBe('#e492c9');
		expect(
			firstFreeColour(presets, [
				{ id: 'g', color: '#808080' },
				{ id: 'n', color: 'tomato' }
			])
		).toBe('#82c7f0');
		expect(
			firstFreeColour(
				presets,
				presets.map((color, i) => ({ id: String(i), color }))
			)
		).toBe('#82c7f0');
		expect(firstFreeColour(presets, [{ id: '__scheduled_tasks__' }, { id: 'p' }])).toBe('#e4c062');
	});
	it('the hidden calendars are kept in this browser, and survive storage that cannot be read', () => {
		localStorage.removeItem(HIDDEN_KEY);
		expect(readHidden()).toEqual(new Set());
		writeHidden(new Set(['a', '__scheduled_tasks__']));
		expect(readHidden()).toEqual(new Set(['a', '__scheduled_tasks__']));
		localStorage.setItem(HIDDEN_KEY, '{not json');
		expect(readHidden()).toEqual(new Set());
		localStorage.setItem(HIDDEN_KEY, '[1, "b"]');
		expect(readHidden()).toEqual(new Set(['b']));
		localStorage.removeItem(HIDDEN_KEY);
	});
});

describe('event form', () => {
	it('an all-day event ending at midnight shows the day before as its end', () => {
		const chat = ev(at(2026, 9, 20), at(2026, 9, 21), { all_day: true });
		expect(eventFields(chat, '', null).endDate).toBe('2026-10-20');
		// Saved unchanged, it stays on the one day.
		expect(eventPayload(eventFields(chat, '', null), chat)).toMatchObject({
			form: { start_at: ns(at(2026, 9, 20)), end_at: ns(at(2026, 9, 20, 23, 59)) }
		});
		const form = ev(at(2026, 9, 20), at(2026, 9, 21, 23, 59), { all_day: true });
		expect(eventFields(form, '', null).endDate).toBe('2026-10-21');
	});
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
	it('an edited event reads its repeat rule, a rule the menu cannot show as custom', () => {
		expect(repeatFromRrule('freq=weekly; byday=MO,TU,WE,TH,FR')).toBe('weekdays');
		expect(repeatFromRrule('FREQ=WEEKLY;INTERVAL=2')).toBe('custom');
		expect(repeatFromRrule(null)).toBe('');
		expect(eventFields(ev(at(2026, 8, 1, 9), undefined, { rrule: 'FREQ=DAILY' }), '', null)).toMatchObject({
			repeat: 'daily',
			endDate: ''
		});
	});
	it('a rule stored with an RRULE: prefix or a DTSTART line reads as the menu rule it is (#707)', () => {
		expect(repeatFromRrule('RRULE:FREQ=DAILY')).toBe('daily');
		expect(repeatFromRrule('rrule:freq=weekly;byday=MO,TU,WE,TH,FR')).toBe('weekdays');
		expect(repeatFromRrule('DTSTART:20261001T090000\nRRULE:FREQ=DAILY')).toBe('daily');
		expect(repeatFromRrule('DTSTART;TZID=Europe/London:20261001T090000\r\nFREQ=MONTHLY')).toBe('monthly');
		// Any other line changes what the rule does, so the menu cannot show it.
		expect(repeatFromRrule('RRULE:FREQ=DAILY\nEXDATE:20261005T090000')).toBe('custom');
		expect(repeatFromRrule('DTSTART:20261001T090000\nRRULE:FREQ=DAILY;INTERVAL=2')).toBe('custom');
	});
	it('needs a title; all-day spans the day; blanks are left out', () => {
		const f = eventFields(null, 'cal', ns(at(2026, 8, 1, 9)));
		expect(eventPayload(f, null)).toEqual({ error: 'Enter a title' });
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
	it('an end before the start is refused, never rewritten (#966)', () => {
		const old = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 11));
		const f = { ...eventFields(old, '', null), startDate: '2026-09-05' };
		expect(eventPayload(f, old)).toEqual({ error: 'End must be after start' });
		expect(eventProblems({ ...f, endDate: '2026-09-05', endTime: '09:00' })).toEqual({
			end: 'End must be after start'
		});
		expect(eventProblems({ ...f, title: '', startDate: '' })).toEqual({
			title: 'Enter a title',
			start: 'Enter a start date'
		});
		// An all-day event may end on the day it starts; no end at all is allowed.
		expect(eventProblems({ ...f, allDay: true, endDate: '2026-09-05' })).toEqual({});
		expect(eventProblems({ ...f, endDate: '' })).toEqual({});
	});
	it('moving the start moves the end with it (#966)', () => {
		const f = eventFields(ev(at(2026, 8, 1, 10), at(2026, 8, 1, 11)), '', null);
		expect(withStart(f, { startTime: '14:00' })).toMatchObject({
			startTime: '14:00',
			endDate: '2026-09-01',
			endTime: '15:00'
		});
		expect(withStart(f, { startDate: '2026-09-03' })).toMatchObject({ endDate: '2026-09-03', endTime: '11:00' });
		// Late in the day the end moves to the next day.
		expect(withStart(f, { startTime: '23:30' })).toMatchObject({ endDate: '2026-09-02', endTime: '00:30' });
		// Half typed, or with an end not after the start, the end stays.
		expect(withStart(f, { startTime: '' })).toMatchObject({ endTime: '11:00' });
		expect(withStart({ ...f, endTime: '09:00' }, { startTime: '14:00' })).toMatchObject({ endTime: '09:00' });
		expect(withStart({ ...f, endDate: '' }, { startTime: '14:00' })).toMatchObject({ endDate: '' });
		const allDay = { ...f, allDay: true, endDate: '2026-09-03' };
		expect(withStart(allDay, { startDate: '2026-09-10' })).toMatchObject({ endDate: '2026-09-12' });
		expect(withStart({ ...allDay, endDate: '2026-08-30' }, { startDate: '2026-09-10' })).toMatchObject({
			endDate: '2026-08-30'
		});
	});
	it('a new event with no time given starts at the next :00 or :30, for an hour (S6-D14)', () => {
		expect(nextHalfHour(at(2026, 8, 1, 9, 28)).getMinutes()).toBe(30);
		expect(nextHalfHour(at(2026, 8, 1, 9, 30))).toEqual(at(2026, 8, 1, 9, 30));
		expect(nextHalfHour(new Date(2026, 8, 1, 9, 30, 5))).toEqual(at(2026, 8, 1, 10));
		expect(nextHalfHour(at(2026, 8, 1, 23, 45))).toEqual(at(2026, 8, 2));
		expect(eventFields(null, 'cal', null, at(2026, 8, 1, 9, 28))).toMatchObject({
			startTime: '09:30',
			endTime: '10:30'
		});
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
	it('choosing No Repeat clears a rule the menu cannot show (#510)', () => {
		const biweekly = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 10), { rrule: 'FREQ=WEEKLY;INTERVAL=2' });
		const out = eventPayload({ ...eventFields(biweekly, '', null), repeat: '' }, biweekly);
		expect('form' in out && out.form.rrule).toBeNull();
		// From one of its occurrences too: it becomes one event at that occurrence.
		const occurrence = {
			...biweekly,
			start_at: ns(at(2026, 8, 15, 9)),
			end_at: ns(at(2026, 8, 15, 10)),
			instance_id: 'x'
		};
		const single = eventPayload(
			{ ...eventFields(occurrence, '', null), repeat: '' },
			occurrence,
			ns(at(2026, 8, 1, 9))
		);
		expect('form' in single && single.form).toMatchObject({ rrule: null, start_at: ns(at(2026, 8, 15, 9)) });
	});
	it('a menu rule stored in another form is kept as it was through an edit, and replaced when changed (#707)', () => {
		const rule = 'DTSTART:20260901T090000\nRRULE:FREQ=DAILY';
		const daily = ev(at(2026, 8, 1, 9), at(2026, 8, 1, 10), { rrule: rule });
		const renamed = eventPayload({ ...eventFields(daily, '', null), title: 'Renamed' }, daily);
		expect('form' in renamed && renamed.form.rrule).toBe(rule);
		const weekly = eventPayload({ ...eventFields(daily, '', null), repeat: 'weekly' }, daily);
		expect('form' in weekly && weekly.form.rrule).toBe('FREQ=WEEKLY');
		// From one of its occurrences, the series keeps its own start too (#318).
		const occurrence = {
			...daily,
			start_at: ns(at(2026, 8, 15, 9)),
			end_at: ns(at(2026, 8, 15, 10)),
			instance_id: 'x'
		};
		const out = eventPayload(
			{ ...eventFields(occurrence, '', null), title: 'Renamed' },
			occurrence,
			ns(at(2026, 8, 1, 9))
		);
		expect('form' in out && out.form).toMatchObject({ rrule: rule, start_at: ns(at(2026, 8, 1, 9)) });
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

describe('reminder options (#324)', () => {
	it('are the standard ones when the event uses one of them', () => {
		expect(reminderOptions(10).map(([m]) => m)).toEqual([-1, 0, 5, 10, 15, 30, 60]);
	});
	it("add the event's own value, in order, when it is not one of them", () => {
		expect(reminderOptions(120)).toContainEqual([120, '2 hours before']);
		expect(reminderOptions(45).map(([m]) => m)).toEqual([-1, 0, 5, 10, 15, 30, 45, 60]);
		expect(reminderOptions(45)).toContainEqual([45, '45 minutes before']);
		expect(reminderOptions(1)).toContainEqual([1, '1 minute before']);
	});
	it("list both the saved value and the form's, and no negative but None", () => {
		expect(reminderOptions(30, 120).map(([m]) => m)).toEqual([-1, 0, 5, 10, 15, 30, 60, 120]);
		expect(reminderOptions(-5).map(([m]) => m)).toEqual([-1, 0, 5, 10, 15, 30, 60]);
	});
	it('read any negative saved reminder as none, as the server does', () => {
		expect(eventFields(ev(at(2026, 8, 1, 9), undefined, { meta: { alert_minutes: -5 } }), '', null).alertMinutes).toBe(
			-1
		);
	});
	it('say when the server will send a reminder earlier than asked', () => {
		expect(reminderOptions(1440)).toContainEqual([1440, '24 hours before (sent 22 hours before)']);
	});
});
