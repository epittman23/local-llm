import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CalendarPage } from './CalendarPage';

const { getCalendars, getCalendarEvents, deleteCalendar } = vi.hoisted(() => ({
	getCalendars: vi.fn(),
	getCalendarEvents: vi.fn(),
	deleteCalendar: vi.fn()
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/calendar', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getCalendars,
	getCalendarEvents,
	deleteCalendar
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));

const calendars = [
	{ id: 'personal', name: 'Personal', color: '#3b82f6', is_default: true, is_system: false },
	{ id: 'work', name: 'Work', color: '#ef4444', is_default: false, is_system: false }
];

const show = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<CalendarPage />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	vi.resetAllMocks();
	getCalendars.mockResolvedValue(calendars);
	getCalendarEvents.mockResolvedValue([]);
});
afterEach(cleanup);

describe('the calendar sidebar mini month', () => {
	it('highlights today with the default variant', async () => {
		show();
		const today = await screen.findByRole('button', { name: new Date().toDateString() });
		expect(today.getAttribute('data-variant')).toBe('default');
	});

	it('jumps the main date to the day that is pressed', async () => {
		show();
		const first = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
		const target = new Date(first.getFullYear(), first.getMonth(), 2);
		const day = await screen.findByRole('button', { name: target.toDateString() });
		fireEvent.click(day);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: target.toDateString() }).getAttribute('data-variant')).toBe('secondary')
		);
	});

	it('pages the mini month with Next month', async () => {
		show();
		const now = new Date();
		const label = (d: Date) => d.toLocaleString('en-US', { month: 'long' });
		await screen.findByRole('button', { name: 'Next month' });
		const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
		fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
		expect(screen.getAllByText(new RegExp(`${label(next)} ${next.getFullYear()}`)).length).toBeGreaterThan(0);
	});
});

describe('the calendar list', () => {
	it('hides and shows a calendar from its toggle', async () => {
		show();
		const toggle = await screen.findByRole('button', { name: 'Work' });
		expect(toggle).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-pressed', 'false');
	});

	it('offers delete only for calendars that are neither default nor system', async () => {
		show();
		expect(await screen.findByRole('button', { name: 'Delete calendar Work' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Delete calendar Personal' })).toBeNull();
	});
});
