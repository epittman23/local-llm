import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CalendarViews, dayName } from './CalendarViews';
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
		const monday = within(band).getByRole('list', { name: '19 October 2026' });
		expect(
			within(monday)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Vacation', 'Trip 1', 'Trip 2', '+2 more']);
		fireEvent.click(within(band).getByRole('button', { name: '+2 more' }));
		expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 9, 19));
	});
});

describe('month cells (#923, #987)', () => {
	const showMonth = (events: never[]) =>
		render(
			<TooltipProvider>
				<CalendarViews
					view="month"
					date={new Date(2026, 10, 14)}
					events={events}
					calendars={calendars}
					onCreate={() => {}}
					onEventClick={() => {}}
					onOpenDay={() => {}}
				/>
			</TooltipProvider>
		);

	it('names each cell by its visible day number, date and event count', () => {
		showMonth([
			event('a', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11)),
			event('b', 'Review', new Date(2026, 10, 14, 15), new Date(2026, 10, 14, 16)),
			event('c', 'Call', new Date(2026, 10, 3, 9), new Date(2026, 10, 3, 10))
		]);
		const cell = screen.getByRole('button', { name: '14 November 2026, 2 events' });
		expect(cell.querySelector('span')?.textContent).toBe('14');
		expect(screen.getByRole('button', { name: '3 November 2026, 1 event' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '20 November 2026, no events' })).toBeInTheDocument();
	});

	it('mutes another month’s day numbers instead of dimming the whole cell', () => {
		showMonth([]);
		const outside = screen.getByRole('button', { name: '1 December 2026, no events' });
		expect(outside).toHaveAttribute('data-outside-month', 'true');
		expect(outside.className).not.toMatch(/opacity/);
		expect(outside.querySelector('span')?.className).toContain('text-foreground-muted');
		const inside = screen.getByRole('button', { name: '2 November 2026, no events' });
		expect(inside).not.toHaveAttribute('data-outside-month');
		expect(inside.querySelector('span')?.className).toMatch(/(^|\s)text-foreground(\s|$)/);
	});

	it('draws an event of a calendar with no colour in the --series-1 token (#989, D1b)', () => {
		render(
			<TooltipProvider>
				<CalendarViews
					view="day"
					date={new Date(2026, 9, 20)}
					events={[Object.assign({}, lunch, { calendar_id: 'plain' })] as never[]}
					calendars={[{ id: 'plain', name: 'Plain', color: null }] as never[]}
					onCreate={() => {}}
					onEventClick={() => {}}
					onOpenDay={() => {}}
				/>
			</TooltipProvider>
		);
		const dot = screen.getByRole('button', { name: /Lunch/ }).querySelector('span') as HTMLElement;
		expect(dot.style.backgroundColor).toBe('var(--series-1)');
	});

	it('shows an automation run in the muted foreground rather than dimming it', () => {
		const run = Object.assign(event('r', 'Nightly report', new Date(2026, 10, 14, 2), new Date(2026, 10, 14, 3)), {
			meta: { automation_id: 'a1' }
		});
		showMonth([run, event('m', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11))]);
		const chip = screen.getByRole('button', { name: /Nightly report/ });
		expect(chip.className).toContain('text-foreground-muted');
		expect(chip.className).not.toMatch(/opacity/);
		expect(screen.getByRole('button', { name: /Seminar/ }).className).not.toContain('text-foreground-muted');
	});

	it('names the hour cells with the same date', () => {
		show('day', new Date(2026, 10, 14), []);
		expect(screen.getByRole('button', { name: 'New event 14 November 2026, 9 AM' })).toBeInTheDocument();
	});
});

describe('today in the grids', () => {
	it('the month view marks only today with the brand circle', () => {
		const now = new Date();
		render(
			<TooltipProvider>
				<CalendarViews
					view="month"
					date={now}
					events={[]}
					calendars={calendars}
					onCreate={() => {}}
					onEventClick={() => {}}
					onOpenDay={() => {}}
				/>
			</TooltipProvider>
		);
		const marked = (d: Date) =>
			screen.getAllByRole('button', { name: new RegExp(`^${dayName(d)}, `) })[0].querySelector('span');
		expect(marked(now)?.className).toContain('bg-brand');
		const other = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 15 ? 16 : 15);
		expect(marked(other)?.className).not.toContain('bg-brand');
	});

	it('the week view marks only today in its header', () => {
		const now = new Date();
		show('week', now, []);
		const circles = screen
			.getAllByText(/^\d{1,2}$/)
			.filter((el) => el.className.includes('rounded-full') && el.className.includes('size-7'));
		expect(circles).toHaveLength(7);
		expect(circles.filter((el) => el.className.includes('bg-brand'))).toHaveLength(1);
		expect(circles.find((el) => el.className.includes('bg-brand'))?.textContent).toBe(String(now.getDate()));
	});
});
