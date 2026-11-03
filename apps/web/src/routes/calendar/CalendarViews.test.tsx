import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CalendarViews } from './CalendarViews';
import { NS } from './calendarModel';

// The day and week grids show an event on every day it touches (#319), as
// the month grid does: all-day events and events carried over from an
// earlier day sit in a band above the hours.

const ns = (d: Date) => d.getTime() * NS;
const event = (id: string, title: string, start: Date, end: Date, allDay = false) =>
	({
		id,
		calendar_id: 'personal',
		user_id: 'u1',
		title,
		start_at: ns(start),
		end_at: ns(end),
		all_day: allDay,
		rrule: null,
		meta: null
	}) as never;
const calendars = [{ id: 'personal', name: 'Personal', color: '#3b82f6' }] as never[];
const conference = event('c', 'Conference', new Date(2026, 9, 19, 9), new Date(2026, 9, 21, 17));
const vacation = event('v', 'Vacation', new Date(2026, 9, 18), new Date(2026, 9, 24, 23, 59), true);
const lunch = event('l', 'Lunch', new Date(2026, 9, 20, 12), new Date(2026, 9, 20, 13));

const show = (view: 'day' | 'week', date: Date, events: never[], onOpenDay = vi.fn()) =>
	render(
		<TooltipProvider>
			<CalendarViews
				view={view}
				date={date}
				events={events}
				calendars={calendars}
				onCreate={() => {}}
				onEventClick={() => {}}
				onOpenDay={onOpenDay}
			/>
		</TooltipProvider>
	);

afterEach(cleanup);

describe('day and week grids', () => {
	it('the day view shows events that began earlier and all-day events in its band', () => {
		show('day', new Date(2026, 9, 20), [conference, vacation, lunch]);

		const band = screen.getByRole('region', { name: 'All-day and continuing events' });
		expect(
			within(band)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Conference', 'Vacation']);
		expect(screen.getByRole('button', { name: /Lunch/ })).toBeTruthy();
	});

	it('the first day of a timed event shows it in its hour, not in the band', () => {
		show('day', new Date(2026, 9, 19), [conference]);

		expect(screen.queryByRole('region', { name: 'All-day and continuing events' })).toBeNull();
		expect(screen.getByRole('button', { name: /Conference/ }).textContent).toMatch(/9:00\s?AM/i);
	});

	it('the week band lists each day, and "+N more" opens that day', () => {
		const onOpenDay = vi.fn();
		const busy = [1, 2, 3, 4].map((i) =>
			event(`b${i}`, `Trip ${i}`, new Date(2026, 9, 19), new Date(2026, 9, 19, 23, 59), true)
		);
		show('week', new Date(2026, 9, 20), [vacation, ...busy], onOpenDay);

		const band = screen.getByRole('region', { name: 'All-day and continuing events' });
		// Vacation is on all seven days (18 to 24 Oct); Monday 19 Oct has four trips too.
		expect(within(band).getAllByRole('button', { name: 'Vacation' })).toHaveLength(7);
		const monday = within(band).getByRole('group', { name: new Date(2026, 9, 19).toDateString() });
		expect(
			within(monday)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Vacation', 'Trip 1', 'Trip 2', '+2 more']);
		fireEvent.click(within(band).getByRole('button', { name: '+2 more' }));
		expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 9, 19));
	});
});
