import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventModel } from '@/lib/apis/calendar';
import { getCalendarEvents } from '@/lib/apis/calendar';
import { getChatList, getPinnedChatList } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { eventTime, HomePage, RECENT_CHATS, todaysEvents } from './HomePage';

vi.mock('@/lib/apis/chats', () => ({ getChatList: vi.fn(), getPinnedChatList: vi.fn() }));
vi.mock('@/lib/apis/calendar', () => ({ getCalendarEvents: vi.fn() }));

const NS = 1_000_000;
const now = Math.floor(Date.now() / 1000);
/** Today at a local hour and minute, in nanoseconds (the calendar's unit). */
const at = (h: number, m = 0, dayOffset = 0) => {
	const d = new Date();
	d.setHours(h, m, 0, 0);
	d.setDate(d.getDate() + dayOffset);
	return d.getTime() * NS;
};
const midnight = () => {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};
const event = (over: Partial<CalendarEventModel>): CalendarEventModel =>
	({
		id: 'e',
		calendar_id: 'personal',
		title: 'Event',
		start_at: at(9),
		end_at: at(10),
		all_day: false,
		meta: null,
		location: null,
		...over
	}) as CalendarEventModel;
const chat = (id: string, title: string, ago = 3600) => ({ id, title, updated_at: now - ago });

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

function show() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={['/home']}>
				<Routes>
					<Route path="/home" element={<HomePage />} />
					<Route path="*" element={<Where />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

function allow({ notes = true, calendar = true, role = 'admin' } = {}) {
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role, permissions: {} } } as never);
	useConfigStore.setState({ config: { features: { enable_notes: notes, enable_calendar: calendar } } } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	allow();
	vi.mocked(getChatList).mockResolvedValue([]);
	vi.mocked(getPinnedChatList).mockResolvedValue([]);
	vi.mocked(getCalendarEvents).mockResolvedValue([]);
});
afterEach(cleanup);

describe('HomePage header and quick actions (LAY-5, ACT-1)', () => {
	it('opens with the h1, one sentence and New chat as the only filled action', async () => {
		show();
		const h1 = screen.getByRole('heading', { level: 1, name: 'Home' });
		expect(h1).toHaveClass('text-heading', 'font-title');
		expect(screen.getByText(/pinned and recent chats, today’s calendar/)).toBeInTheDocument();
		const newChat = screen.getByRole('link', { name: 'New chat' });
		expect(newChat).toHaveAttribute('href', '/');
		expect(newChat).toHaveAttribute('data-variant', 'default');
		const actions = within(screen.getByRole('list', { name: 'Quick actions' }));
		expect(actions.getAllByRole('link').map((l) => l.textContent?.trim())).toEqual(['New note', 'Calendar']);
		expect(actions.getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
		expect(actions.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
		expect(await screen.findByText('Nothing on your calendar today.')).toBeInTheDocument();
	});

	it('opens the chat search', () => {
		useUIStore.setState({ searchOpen: false });
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
	});

	it('offers notes and the calendar only to someone who may use them', async () => {
		allow({ calendar: true, notes: true, role: 'user' });
		show();
		const actions = within(screen.getByRole('list', { name: 'Quick actions' }));
		expect(actions.getAllByRole('link').map((l) => l.textContent?.trim())).toEqual(['New note']);
		expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
		await screen.findByText(/No chats yet/);
		expect(getCalendarEvents).not.toHaveBeenCalled();
	});

	it('keeps Search chats when nothing else is on', () => {
		allow({ notes: false, calendar: false });
		show();
		const actions = within(screen.getByRole('list', { name: 'Quick actions' }));
		expect(actions.queryAllByRole('link')).toHaveLength(0);
		expect(actions.getByRole('button', { name: 'Search chats' })).toBeInTheDocument();
	});
});

describe('HomePage chats (STA-1)', () => {
	it('lists pinned chats first, then the most recent, each with its relative time, and opens the one pressed', async () => {
		vi.mocked(getPinnedChatList).mockResolvedValue([chat('p1', 'Course notes outline', 2 * 86_400)]);
		vi.mocked(getChatList).mockResolvedValue(
			Array.from({ length: 12 }, (_, i) => chat(`c${i}`, `Chat ${i}`, (i + 1) * 3600)).concat(
				chat('p1', 'Course notes outline')
			)
		);
		show();
		const region = within(screen.getByRole('region', { name: 'Pinned and recent chats' }));
		await region.findByText('Chat 0');
		const rows = region.getAllByRole('button');
		expect(rows).toHaveLength(1 + RECENT_CHATS);
		expect(rows[0]).toHaveTextContent('Pinned: Course notes outline');
		expect(rows[0]).toHaveTextContent('2 days ago');
		expect(rows[1]).toHaveTextContent('Chat 0');
		expect(rows[1]).toHaveTextContent('an hour ago');
		expect(rows[1].querySelector('time')).toHaveAttribute('title');
		expect(rows.at(-1)).toHaveTextContent(`Chat ${RECENT_CHATS - 1}`);
		expect(screen.getByTitle('Chat 0')).toHaveClass('truncate');
		fireEvent.click(rows[1]);
		expect(screen.getByTestId('where').textContent).toBe('/c/c0');
	});

	it('shows a skeleton while loading, then the first step when there are no chats (STA-2, STA-3)', async () => {
		let resolve: (v: never[]) => void = () => {};
		vi.mocked(getChatList).mockImplementation(() => new Promise((r) => (resolve = r)));
		show();
		expect(screen.getByTestId('home-chats-loading')).toBeInTheDocument();
		resolve([]);
		expect(await screen.findByText(/No chats yet/)).toBeInTheDocument();
		expect(screen.queryByTestId('home-chats-loading')).toBeNull();
		expect(screen.getByRole('link', { name: 'Start a chat' })).toHaveAttribute('href', '/');
	});

	it('says in place when the chats fail, and tries the failed list again (STA-4)', async () => {
		vi.mocked(getPinnedChatList).mockRejectedValueOnce('Database is locked');
		show();
		expect(await screen.findByText("Couldn't load chats")).toBeInTheDocument();
		expect(screen.getByText('Database is locked')).toBeInTheDocument();
		vi.mocked(getPinnedChatList).mockResolvedValue([chat('p1', 'Pinned one')]);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Pinned one')).toBeInTheDocument();
		expect(getChatList).toHaveBeenCalledTimes(1);
	});
});

describe('HomePage today (STA-1)', () => {
	it('lists today’s events, all-day first, and opens the calendar or an automation’s chat', async () => {
		vi.mocked(getCalendarEvents).mockResolvedValue([
			event({ id: 'late', title: 'Office hours', start_at: at(15), end_at: at(16), location: 'Room 2' }),
			event({
				id: 'run',
				title: 'Daily summary',
				start_at: at(8),
				end_at: null,
				meta: { automation_id: 'a1', chat_id: 'c9' }
			}),
			event({ id: 'all', title: 'Deadline', start_at: at(0), end_at: at(0, 0, 1), all_day: true }),
			event({ id: 'tomorrow', title: 'Tomorrow', start_at: at(9, 0, 1), end_at: at(10, 0, 1) })
		]);
		show();
		const section = within(screen.getByRole('region', { name: 'Today' }));
		await section.findByText('Office hours');
		const rows = section.getAllByRole('button');
		expect(rows.map((r) => r.textContent)).toEqual([
			'All dayDeadline',
			'08:00Daily summary',
			'15:00–16:00Office hoursRoom 2'
		]);
		fireEvent.click(rows[2]);
		expect(screen.getByTestId('where').textContent).toBe('/calendar');
	});

	it('opens what an automation’s run posted to', async () => {
		vi.mocked(getCalendarEvents).mockResolvedValue([
			event({ id: 'run', title: 'Daily summary', meta: { automation_id: 'a1', chat_id: 'c9' } })
		]);
		show();
		fireEvent.click(await screen.findByRole('button', { name: /Daily summary/ }));
		expect(screen.getByTestId('where').textContent).toBe('/c/c9');
	});

	it('asks for the day the Calendar page’s day view asks for', async () => {
		show();
		await waitFor(() => expect(getCalendarEvents).toHaveBeenCalled());
		const [, start, end] = vi.mocked(getCalendarEvents).mock.calls[0];
		expect(new Date(start).getTime()).toBe(midnight());
		expect(new Date(end).getTime() - new Date(start).getTime()).toBeGreaterThanOrEqual(23 * 3_600_000);
	});

	it('shows a skeleton, then the way to the calendar when the day is empty (STA-2, STA-3)', async () => {
		let resolve: (v: CalendarEventModel[]) => void = () => {};
		vi.mocked(getCalendarEvents).mockImplementation(() => new Promise((r) => (resolve = r)));
		show();
		expect(screen.getByTestId('home-today-loading')).toBeInTheDocument();
		resolve([]);
		expect(await screen.findByText('Nothing on your calendar today.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open calendar' })).toHaveAttribute('href', '/calendar');
	});

	it('says in place when the calendar fails, and tries again (STA-4)', async () => {
		vi.mocked(getCalendarEvents).mockRejectedValueOnce('Calendar unavailable');
		show();
		const section = within(screen.getByRole('region', { name: 'Today' }));
		expect(await section.findByText("Couldn't load today’s calendar")).toBeInTheDocument();
		vi.mocked(getCalendarEvents).mockResolvedValue([event({ title: 'Seminar' })]);
		fireEvent.click(section.getByRole('button', { name: 'Try again' }));
		expect(await section.findByText('Seminar')).toBeInTheDocument();
	});
});

describe('eventTime and todaysEvents', () => {
	const day = midnight();
	it('says when an event happens today', () => {
		expect(eventTime(event({ all_day: true }), day)).toBe('All day');
		expect(eventTime(event({ start_at: at(9), end_at: at(10, 30) }), day)).toBe('09:00–10:30');
		expect(eventTime(event({ start_at: at(9), end_at: null }), day)).toBe('09:00');
		expect(eventTime(event({ start_at: at(22, 0, -1), end_at: at(7) }), day)).toBe('Until 07:00');
		expect(eventTime(event({ start_at: at(22), end_at: at(2, 0, 1) }), day)).toBe('From 22:00');
		expect(eventTime(event({ start_at: at(9, 0, -1), end_at: at(9, 0, 1) }), day)).toBe('All day');
		expect(eventTime(event({ start_at: at(9, 0, -1), end_at: null }), day)).toBe('All day');
	});

	it('keeps the events that touch today, including one that began yesterday', () => {
		const list = todaysEvents(
			[
				event({ id: 'b', start_at: at(11) }),
				event({ id: 'y', start_at: at(22, 0, -1), end_at: at(7) }),
				event({ id: 'old', start_at: at(9, 0, -1), end_at: at(10, 0, -1) }),
				event({ id: 'a', start_at: at(10), end_at: at(11) })
			],
			new Date()
		);
		expect(list.map((e) => e.id)).toEqual(['y', 'a', 'b']);
	});
});
