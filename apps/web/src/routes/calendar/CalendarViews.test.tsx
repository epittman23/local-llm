import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CalendarViews, monthCellName } from './CalendarViews';
import { dayName, NS } from './calendarModel';

// The day and week grids show an event on every day it touches (#319), as
// the month grid does: all-day events and events carried over from an
// earlier day sit in a band above the hours.

const ns = (d: Date) => d.getTime() * NS;
const event = (id: string, title: string, start: Date, end: Date | null, allDay = false) =>
	({
		id,
		calendar_id: 'personal',
		user_id: 'u1',
		title,
		start_at: ns(start),
		end_at: end ? ns(end) : null,
		all_day: allDay,
		rrule: null,
		meta: null
	}) as never;
const run = (id: string, automation: string, title: string, start: Date) =>
	Object.assign(event(id, title, start, null), {
		calendar_id: '__scheduled_tasks__',
		instance_id: `${id}_i`,
		meta: { automation_id: automation }
	}) as never;
const calendars = [
	{ id: 'personal', name: 'Personal', color: '#3b82f6' },
	{ id: '__scheduled_tasks__', name: 'Automations', color: '#8b5cf6', is_system: true }
] as never[];
const conference = event('c', 'Conference', new Date(2026, 9, 19, 9), new Date(2026, 9, 21, 17));
const vacation = event('v', 'Vacation', new Date(2026, 9, 18), new Date(2026, 9, 24, 23, 59), true);
const lunch = event('l', 'Lunch', new Date(2026, 9, 20, 12), new Date(2026, 9, 20, 13));

type Extra = Partial<{
	onOpenDay: () => void;
	onCreate: (ns: number) => void;
	onEventClick: () => void;
	onSelectDay: (d: Date) => void;
	compact: boolean;
	weekStart: number;
	calendars: never[];
}>;

const show = (view: 'day' | 'week' | 'month', date: Date, events: never[], extra: Extra = {}) =>
	render(
		<MemoryRouter initialEntries={['/calendar']}>
			<Routes>
				<Route
					path="/calendar"
					element={
						<TooltipProvider>
							<CalendarViews
								view={view}
								date={date}
								events={events}
								calendars={extra.calendars ?? calendars}
								weekStart={extra.weekStart ?? 0}
								compact={extra.compact ?? false}
								onCreate={extra.onCreate ?? (() => {})}
								onEventClick={extra.onEventClick ?? (() => {})}
								onOpenDay={extra.onOpenDay ?? (() => {})}
								onSelectDay={extra.onSelectDay ?? (() => {})}
							/>
						</TooltipProvider>
					}
				/>
				<Route path="/automations/:id" element={<p>automation page</p>} />
			</Routes>
		</MemoryRouter>
	);

afterEach(cleanup);

describe('day and week grids', () => {
	it('the day view shows events that began earlier and all-day events in its band', () => {
		show('day', new Date(2026, 9, 20), [conference, vacation, lunch]);

		const band = screen.getByRole('region', { name: 'All-day events and runs' });
		expect(
			within(band)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Vacation', 'Conference']);
		expect(screen.getByRole('button', { name: /Lunch/ })).toBeTruthy();
	});

	it('the first day of a timed event shows it in the grid with its start and end, not in the band', () => {
		show('day', new Date(2026, 9, 19), [conference]);

		expect(screen.queryByRole('region', { name: 'All-day events and runs' })).toBeNull();
		expect(screen.getByRole('button', { name: /Conference/ }).textContent).toMatch(/9:00\sAM – 5:00\sPM/);
	});

	it('the week band lists each day, and "+N more" opens that day', () => {
		const onOpenDay = vi.fn();
		const busy = [1, 2, 3, 4].map((i) =>
			event(`b${i}`, `Trip ${i}`, new Date(2026, 9, 19), new Date(2026, 9, 19, 23, 59), true)
		);
		show('week', new Date(2026, 9, 20), [vacation, ...busy], { onOpenDay });

		const band = screen.getByRole('region', { name: 'All-day events and runs' });
		// Vacation is on all seven days (18 to 24 Oct); Monday 19 Oct has four trips too.
		expect(within(band).getAllByRole('button', { name: 'Vacation' })).toHaveLength(7);
		const monday = within(band).getByRole('list', { name: '19 October 2026' });
		expect(
			within(monday)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Vacation', 'Trip 1', 'Trip 2', '+2 more']);
		fireEvent.click(within(band).getByRole('button', { name: '2 more on 19 October 2026' }));
		expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 9, 19));
	});

	it('draws a block as tall as the event lasts (#937)', () => {
		const long = event('a', 'Long', new Date(2026, 9, 20, 9), new Date(2026, 9, 20, 11));
		const short = event('b', 'Short', new Date(2026, 9, 20, 14), new Date(2026, 9, 20, 15));
		show('day', new Date(2026, 9, 20), [long, short]);
		const block = (name: RegExp) => screen.getByRole('button', { name }) as HTMLElement;
		// 48 px an hour on a fine pointer.
		expect(block(/Long/).style.top).toBe('432px');
		expect(block(/Long/).style.height).toBe('95px');
		expect(block(/Short/).style.height).toBe('47px');
	});

	it('draws a short event at the least target height, not a pixel under it (#983, LAY-3)', () => {
		const standup = event('c', 'Stand-up', new Date(2026, 9, 20, 9), new Date(2026, 9, 20, 9, 15));
		show('day', new Date(2026, 9, 20), [standup]);
		expect((screen.getByRole('button', { name: /Stand-up/ }) as HTMLElement).style.height).toBe('24px');
	});

	it('puts overlapping events side by side', () => {
		const a = event('a', 'A', new Date(2026, 9, 20, 9), new Date(2026, 9, 20, 11));
		const b = event('b', 'B', new Date(2026, 9, 20, 10), new Date(2026, 9, 20, 12));
		show('day', new Date(2026, 9, 20), [a, b]);
		const style = (name: string) => (screen.getByRole('button', { name: new RegExp(`^${name}`) }) as HTMLElement).style;
		expect(style('A').width).toBe('calc(50% - 4px)');
		expect(style('A').left).toBe('calc(0% + 2px)');
		expect(style('B').left).toBe('calc(50% + 2px)');
	});

	it('pressing empty time asks for an event at that hour', () => {
		const onCreate = vi.fn();
		show('day', new Date(2026, 10, 14), [], { onCreate });
		fireEvent.click(screen.getByRole('button', { name: 'New event 14 November 2026, 9 AM' }));
		expect(onCreate).toHaveBeenCalledWith(new Date(2026, 10, 14, 9).getTime() * NS);
	});

	it('collapses an automation’s runs on a day into one item in the band, which opens the automation (#936)', () => {
		const runs = [9, 10, 11].map((h) => run(`r${h}`, 'a1', 'Digest', new Date(2026, 9, 20, h)));
		show('day', new Date(2026, 9, 20), [...runs, lunch]);
		const band = screen.getByRole('region', { name: 'All-day events and runs' });
		const item = within(band).getByRole('button', { name: /^Digest ?, 3 runs$/ });
		fireEvent.click(item);
		expect(screen.getByText('automation page')).toBeInTheDocument();
	});

	it('scrolls the grid to 7 AM on a day without today, and draws no now-line', () => {
		show('day', new Date(2020, 0, 6), []);
		expect(screen.getByTestId('time-grid').scrollTop).toBe(7 * 48);
		expect(document.querySelector('[data-now]')).toBeNull();
	});
});

describe('month cells (#923, #987)', () => {
	const showMonth = (events: never[], extra: Extra = {}) => show('month', new Date(2026, 10, 14), events, extra);

	it('names each day by its visible day number, date, weekday and event count', () => {
		showMonth([
			event('a', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11)),
			event('b', 'Review', new Date(2026, 10, 14, 15), new Date(2026, 10, 14, 16)),
			event('c', 'Call', new Date(2026, 10, 3, 9), new Date(2026, 10, 3, 10))
		]);
		const cell = screen.getByRole('button', { name: '14 November 2026, Saturday, 2 events' });
		expect(cell.textContent).toBe('14');
		expect(screen.getByRole('button', { name: '3 November 2026, Tuesday, 1 event' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '20 November 2026, Friday, no events' })).toBeInTheDocument();
	});

	it('keeps event chips beside the day button, never inside it (#987)', () => {
		showMonth([event('a', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11))]);
		const day = screen.getByRole('button', { name: /^14 November 2026,/ });
		expect(day.querySelector('button')).toBeNull();
		expect(screen.getByRole('button', { name: /Seminar/ })).toBeInTheDocument();
	});

	it('mutes another month’s day numbers instead of dimming the whole cell', () => {
		showMonth([]);
		const outside = screen.getByRole('button', { name: /^1 December 2026, / });
		expect(outside).toHaveAttribute('data-outside-month', 'true');
		expect(outside.className).not.toMatch(/opacity/);
		expect(outside.querySelector('span')?.className).toContain('text-foreground-muted');
		const inside = screen.getByRole('button', { name: /^2 November 2026, / });
		expect(inside).not.toHaveAttribute('data-outside-month');
		expect(inside.querySelector('span')?.className).toMatch(/(^|\s)text-foreground(\s|$)/);
	});

	it('draws an event of a calendar with no colour in the --series-1 token (#989, D1b)', () => {
		show('day', new Date(2026, 9, 20), [Object.assign({}, lunch, { calendar_id: 'plain' })] as never[], {
			calendars: [{ id: 'plain', name: 'Plain', color: null }] as never[]
		});
		const block = screen.getByRole('button', { name: /Lunch/ }) as HTMLElement;
		expect(block.style.borderLeftColor).toBe('var(--series-1)');
	});

	it('draws the Automations calendar in --series-6, whatever colour the server sends (S6-D10)', () => {
		showMonth([run('r', 'a1', 'Nightly report', new Date(2026, 10, 14, 2))]);
		const dot = screen.getByRole('button', { name: /Nightly report/ }).querySelector('span') as HTMLElement;
		expect(dot.style.backgroundColor).toBe('var(--series-6)');
	});

	it('shows an automation run in the muted foreground rather than dimming it, after your own events', () => {
		showMonth([
			run('r', 'a1', 'Nightly report', new Date(2026, 10, 14, 2)),
			event('m', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11))
		]);
		const chip = screen.getByRole('button', { name: /Nightly report/ });
		expect(chip.className).toContain('text-foreground-muted');
		expect(chip.className).not.toMatch(/opacity/);
		const seminar = screen.getByRole('button', { name: /Seminar/ });
		expect(seminar.className).not.toContain('text-foreground-muted');
		expect(seminar.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('never lets runs push your own events out of a cell (#936)', () => {
		const flood = [1, 2, 3].flatMap((a) =>
			[0, 1, 2, 3].map((h) => run(`r${a}-${h}`, `a${a}`, `Auto ${a}`, new Date(2026, 10, 14, h)))
		);
		showMonth([...flood, event('m', 'Seminar', new Date(2026, 10, 14, 10), new Date(2026, 10, 14, 11))]);
		expect(screen.getByRole('button', { name: /Seminar/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Auto 1 ?, 4 runs$/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '2 more on 14 November 2026' })).toBeInTheDocument();
	});

	it('draws a multi-day event as one bar across its days (#1107)', () => {
		const trip = event('t', 'Conference', new Date(2026, 10, 24), new Date(2026, 10, 26, 23, 59), true);
		showMonth([trip]);
		const bars = screen.getAllByRole('button', { name: /Conference/ });
		expect(bars).toHaveLength(1);
		const wrapper = bars[0].parentElement as HTMLElement;
		expect(wrapper.style.gridColumn).toBe('3 / span 3');
	});

	it('pressing a day asks for a 9 AM event there; in the compact month it chooses the day', () => {
		const onCreate = vi.fn();
		const onSelectDay = vi.fn();
		showMonth([], { onCreate });
		fireEvent.click(screen.getByRole('button', { name: /^18 November 2026,/ }));
		expect(onCreate).toHaveBeenCalledWith(new Date(2026, 10, 18, 9).getTime() * NS);
		cleanup();
		showMonth([], { compact: true, onSelectDay, onCreate });
		fireEvent.click(screen.getByRole('button', { name: /^18 November 2026,/ }));
		expect(onSelectDay).toHaveBeenCalledWith(new Date(2026, 10, 18));
	});

	it('the compact month shows dots, the count, and the chosen day’s agenda (S6-D11)', () => {
		const onCreate = vi.fn();
		const events = [1, 2, 3, 4].map((h) =>
			event(`e${h}`, `Thing ${h}`, new Date(2026, 10, 14, 9 + h), new Date(2026, 10, 14, 10 + h))
		);
		showMonth(events, { compact: true, onCreate });
		const day = screen.getByRole('button', { name: /^14 November 2026,/ });
		expect(day.textContent).toBe('14');
		expect(day.querySelector('[data-count]')).toHaveAttribute('data-count', '4');
		const agenda = screen.getByRole('region', { name: /14 November|November 14/ });
		expect(within(agenda).getAllByRole('button')).toHaveLength(4);
		cleanup();
		showMonth([], { compact: true, onCreate });
		fireEvent.click(screen.getByRole('button', { name: 'New event on this day' }));
		expect(onCreate).toHaveBeenCalledWith(new Date(2026, 10, 14, 9).getTime() * NS);
	});

	it('starts the week on the locale’s first day', () => {
		showMonth([], { weekStart: 1 });
		const days = screen.getAllByRole('button', { name: /2026, / });
		expect(days[0]).toHaveAccessibleName(monthCellName(new Date(2026, 9, 26), 0));
	});
});

describe('the day grid is one tab stop (NAV-5)', () => {
	it('the arrow keys, Home and End move between days; past the edge asks for that date', () => {
		const onSelectDay = vi.fn();
		show('month', new Date(2026, 10, 14), [], { onSelectDay });
		const day = (d: number) => screen.getByRole('button', { name: new RegExp(`^${d} November 2026,`) });
		expect(day(14)).toHaveAttribute('tabindex', '0');
		expect(day(15)).toHaveAttribute('tabindex', '-1');
		act(() => day(14).focus());
		fireEvent.keyDown(day(14), { key: 'ArrowRight' });
		expect(document.activeElement).toBe(day(15));
		fireEvent.keyDown(day(15), { key: 'ArrowDown' });
		expect(document.activeElement).toBe(day(22));
		fireEvent.keyDown(day(22), { key: 'End' });
		expect(document.activeElement).toBe(day(28));
		fireEvent.keyDown(day(28), { key: 'Home' });
		expect(document.activeElement).toBe(day(22));
		fireEvent.keyDown(day(22), { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(day(21));
		fireEvent.keyDown(day(21), { key: 'a' });
		expect(document.activeElement).toBe(day(21));
		const first = screen.getByRole('button', { name: /^1 November 2026,/ });
		act(() => first.focus());
		fireEvent.keyDown(first, { key: 'ArrowUp' });
		expect(onSelectDay).toHaveBeenCalledWith(new Date(2026, 9, 25));
	});
});

describe('today in the grids', () => {
	it('the month view marks only today with the brand circle', () => {
		const now = new Date();
		show('month', now, []);
		const marked = (d: Date) =>
			screen.getAllByRole('button', { name: new RegExp(`^${dayName(d)}, `) })[0].querySelector('span');
		expect(marked(now)?.className).toContain('bg-brand');
		const other = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 15 ? 16 : 15);
		expect(marked(other)?.className).not.toContain('bg-brand');
	});

	it('the week view marks only today in its header, tints its column and draws the now-line', () => {
		const now = new Date();
		show('week', now, []);
		const circles = screen
			.getAllByText(/^\d{1,2}$/)
			.filter((el) => el.className.includes('rounded-full') && el.className.includes('size-7'));
		expect(circles).toHaveLength(7);
		expect(circles.filter((el) => el.className.includes('bg-brand'))).toHaveLength(1);
		expect(circles.find((el) => el.className.includes('bg-brand'))?.textContent).toBe(String(now.getDate()));
		expect(document.querySelectorAll('[data-today]')).toHaveLength(1);
		expect(document.querySelector('[data-now]')).not.toBeNull();
	});
});
