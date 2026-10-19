import { describe, it } from 'vitest';
import { NS, eventsByDay, eventsInHour, dayKey } from '@/routes/calendar/calendarModel';

describe('multi-day', () => {
	it('day/week grids vs month grid', () => {
		const e: any = { id: 'trip', calendar_id: 'c', title: 'Conference', all_day: false, rrule: null, meta: {},
			start_at: new Date(2026, 9, 19, 10).getTime() * NS, end_at: new Date(2026, 9, 21, 12).getTime() * NS };
		const allDay: any = { ...e, id: 'vac', title: 'Vacation', all_day: true,
			start_at: new Date(2026, 9, 19, 0).getTime() * NS, end_at: new Date(2026, 9, 23, 23, 59).getTime() * NS };
		const tue = new Date(2026, 9, 20);
		console.log('month cell Oct 20:', eventsByDay([e, allDay])[dayKey(tue)]?.map((x: any) => x.title));
		const hours = Array.from({ length: 24 }, (_, h) => eventsInHour([e, allDay], tue, h).length).reduce((a, b) => a + b, 0);
		console.log('day view Oct 20, events across all 24 rows:', hours);
	});
});
