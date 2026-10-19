import { describe, expect, it } from 'vitest';
import type { CalendarEventModel } from '@/lib/apis/calendar';
import {
	NS,
	automationTarget,
	eventFields,
	eventPayload,
	eventsInHour
} from '@/routes/calendar/calendarModel';

const base: CalendarEventModel = {
	id: 'evt1',
	calendar_id: 'cal1',
	user_id: 'u1',
	title: 'Standup',
	description: null,
	start_at: new Date(2026, 9, 1, 9, 0).getTime() * NS, // series starts Oct 1 09:00
	end_at: new Date(2026, 9, 1, 9, 30).getTime() * NS,
	all_day: false,
	rrule: 'FREQ=DAILY',
	color: null,
	location: null,
	data: null,
	meta: { alert_minutes: 10 },
	is_cancelled: false,
	attendees: [],
	created_at: 0,
	updated_at: 0
};

describe('W11 calendar repros', () => {
	it('tz in effect', () => {
		console.log('TZ', Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(2026, 10, 1).getTimezoneOffset());
	});

	it('editing an occurrence rewrites the series start', () => {
		// What GET /calendars/events returns for the Oct 20 occurrence (expand_recurring_event): same id, the occurrence's times.
		const occStart = new Date(2026, 9, 20, 9, 0).getTime() * NS;
		const occurrence = { ...base, start_at: occStart, end_at: occStart + 30 * 60_000 * NS, instance_id: `evt1_${occStart}` };
		const f = eventFields(occurrence, 'cal1', null);
		const out = eventPayload({ ...f, title: 'Standup (renamed)' }, occurrence);
		if ('error' in out) throw new Error(out.error);
		console.log('series start before:', new Date(base.start_at / NS).toString());
		console.log('start_at sent to /events/evt1/update:', new Date(out.form.start_at / NS).toString());
		expect(out.form.start_at).toBe(occStart);
		expect(out.form.start_at).not.toBe(base.start_at);
	});

	it('channel automation run from the calendar', () => {
		const run = { ...base, id: 'run_r1', rrule: null, meta: { automation_id: 'a1', run_id: 'r1', chat_id: 'channel:ch1', status: 'success' } };
		console.log('calendar click target:', automationTarget(run));
		expect(automationTarget(run)).toBe('/c/channel:ch1');
	});

	it('DST rows (America/New_York)', () => {
		const ev = (y: number, m: number, d: number, h: number, min: number, offsetMs = 0) => ({
			...base,
			rrule: null,
			id: `${y}-${m}-${d}-${h}-${min}-${offsetMs}`,
			start_at: (new Date(y, m, d, h, min).getTime() + offsetMs) * NS
		});
		// Spring forward 2026-03-08: 02:00 -> 03:00
		const spring = new Date(2026, 2, 8);
		const e330 = ev(2026, 2, 8, 3, 30);
		const rows = [1, 2, 3, 4].map((h) => [h, eventsInHour([e330], spring, h).length]);
		console.log('spring-forward 03:30 event, rows [hour, count]:', JSON.stringify(rows));
		// Fall back 2026-11-01: 01:00 EDT -> 01:00 EST; an event at 01:30 EST (second 1:30)
		const fall = new Date(2026, 10, 1);
		const firstOneThirty = new Date(2026, 10, 1, 1, 30).getTime(); // JS picks the earlier (EDT)
		const secondOneThirty = { ...base, rrule: null, id: 'x', start_at: (firstOneThirty + 3_600_000) * NS };
		console.log('second 01:30 is', new Date(secondOneThirty.start_at / NS).toString());
		const rows2 = [0, 1, 2, 3].map((h) => [h, eventsInHour([secondOneThirty], fall, h).length]);
		console.log('fall-back second 01:30 event, rows [hour, count]:', JSON.stringify(rows2));
	});
});
