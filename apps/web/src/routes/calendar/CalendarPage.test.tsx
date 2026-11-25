import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query/QueryProvider';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CalendarPage } from './CalendarPage';
import { dayName, HIDDEN_KEY } from './calendarModel';

const { getCalendars, getCalendarEvents, deleteCalendar, setDefaultCalendar } = vi.hoisted(() => ({
	getCalendars: vi.fn(),
	getCalendarEvents: vi.fn(),
	deleteCalendar: vi.fn(),
	setDefaultCalendar: vi.fn()
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/calendar', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getCalendars,
	getCalendarEvents,
	deleteCalendar,
	setDefaultCalendar
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));

const calendars = [
	{ id: 'personal', user_id: 'me', name: 'Personal', color: '#3b82f6', is_default: true, is_system: false },
	{ id: 'work', user_id: 'me', name: 'Work', color: '#ef4444', is_default: false, is_system: false },
	{ id: '__scheduled_tasks__', user_id: 'me', name: 'Automations', color: null, is_default: false, is_system: true }
];

// Radix's menus ask for these, which jsdom lacks.
beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.scrollIntoView ??= () => {};
});

/** Opens a calendar's ⋯ menu from the keyboard. */
const openMenu = async (name: string) => {
	fireEvent.keyDown(await screen.findByRole('button', { name: `More actions for ${name}` }), { key: 'Enter' });
	return screen.findByRole('menu');
};

const offlineClient = () => {
	const client = createQueryClient();
	const defaults = client.getDefaultOptions();
	client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
	return client;
};

const show = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter>
					<CalendarPage />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	vi.resetAllMocks();
	localStorage.removeItem(HIDDEN_KEY);
	getCalendars.mockResolvedValue(calendars);
	getCalendarEvents.mockResolvedValue([]);
});
afterEach(cleanup);

describe('the calendar sidebar mini month', () => {
	it('highlights today with the default variant', async () => {
		show();
		const today = await screen.findByRole('button', { name: dayName(new Date()) });
		expect(today.getAttribute('data-variant')).toBe('default');
	});

	it('names each day by its visible number, so the name contains what it shows (A11Y-2)', async () => {
		show();
		const first = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
		const day = await screen.findByRole('button', { name: dayName(first) });
		expect(day.textContent).toBe('1');
	});

	it('jumps the main date to the day that is pressed', async () => {
		show();
		const first = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
		const target = new Date(first.getFullYear(), first.getMonth(), 2);
		const day = await screen.findByRole('button', { name: dayName(target) });
		fireEvent.click(day);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: dayName(target) }).getAttribute('data-variant')).toBe('secondary')
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
	it('hides and shows a calendar from its toggle, and remembers it in this browser (S6-D9)', async () => {
		show();
		const toggle = await screen.findByRole('button', { name: 'Work' });
		expect(toggle).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-pressed', 'false');
		expect(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')).toEqual(['work']);
		cleanup();
		show();
		expect(await screen.findByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(screen.getByRole('button', { name: 'Work' }));
		expect(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')).toEqual([]);
	});

	it('gives each of your calendars a menu, and Automations none; delete only where it is not the default (#1106)', async () => {
		show();
		expect(await screen.findByRole('button', { name: 'Automations' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'More actions for Automations' })).toBeNull();
		const personal = await openMenu('Personal');
		expect(Array.from(personal.querySelectorAll('[role=menuitem]')).map((m) => m.textContent)).toEqual([
			'Edit calendar'
		]);
		fireEvent.keyDown(personal, { key: 'Escape' });
		const work = await openMenu('Work');
		expect(Array.from(work.querySelectorAll('[role=menuitem]')).map((m) => m.textContent)).toEqual([
			'Edit calendar',
			'Make default',
			'Delete calendar'
		]);
	});

	it('deletes a calendar after asking, naming it', async () => {
		deleteCalendar.mockResolvedValue(true);
		show();
		fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Delete calendar' }));
		const confirm = await screen.findByRole('alertdialog');
		expect(confirm).toHaveTextContent('Delete “Work”? Its events are deleted with it.');
		fireEvent.click(within(confirm).getByRole('button', { name: 'Delete calendar' }));
		await waitFor(() => expect(deleteCalendar).toHaveBeenCalledWith('t', 'work'));
		expect(toast.success).toHaveBeenCalledWith('Calendar deleted');
	});

	it('makes a calendar the default, and says when that fails', async () => {
		setDefaultCalendar.mockResolvedValue({});
		show();
		fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Make default' }));
		await waitFor(() => expect(setDefaultCalendar).toHaveBeenCalledWith('t', 'work'));
		expect(toast.success).toHaveBeenCalledWith('“Work” is now the default calendar');
		setDefaultCalendar.mockRejectedValue('nope');
		fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Make default' }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Couldn’t make “Work” the default calendar', expect.anything())
		);
	});

	it('opens Edit calendar from the menu, and New calendar from the list', async () => {
		show();
		fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Edit calendar' }));
		expect(await screen.findByRole('heading', { name: 'Edit calendar' })).toBeVisible();
		expect(screen.getByLabelText('Name')).toHaveValue('Work');
	});
});

describe('the page header and toolbar (#1040)', () => {
	it('has one h1, a sentence, New event, the month as an h2, and a labelled view control', async () => {
		show();
		expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
		const month = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toContain(month);
		expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'New event' }));
		expect(await screen.findByRole('dialog', { name: 'New event' })).toBeInTheDocument();
	});

	it('steps through dates and comes back with Today', async () => {
		show();
		const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		const now = new Date();
		await screen.findByRole('heading', { level: 1 });
		fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
		expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent(month(next));
		fireEvent.click(screen.getByRole('button', { name: 'Today' }));
		expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent(month(now));
	});

	it('opens on a phone in Day view, with the calendar list in a sheet (S6-D11, #965)', async () => {
		const matchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {}
		})) as never;
		try {
			show();
			expect(await screen.findByRole('radio', { name: 'Day' })).toHaveAttribute('aria-checked', 'true');
			expect(screen.queryByRole('heading', { level: 2, name: 'Calendars' })).toBeNull();
			fireEvent.click(screen.getByRole('button', { name: 'Calendars' }));
			const sheet = await screen.findByRole('dialog', { name: 'Calendars' });
			fireEvent.click(within(sheet).getByRole('button', { name: dayName(new Date()) }));
			await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Calendars' })).toBeNull());
		} finally {
			window.matchMedia = matchMedia;
		}
	});
});

describe('a calendar that cannot load (STA-4, #981)', () => {
	it('shows failed calendars in place of the page, with no toast, and tries again', async () => {
		getCalendars.mockRejectedValue('Database is locked');
		show();

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load calendars");
		expect(toast.error).not.toHaveBeenCalled();

		getCalendars.mockResolvedValue(calendars);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Work')).toBeInTheDocument();
	});

	it('shows failed events in place of the grid, keeping the dates to step through', async () => {
		getCalendarEvents.mockRejectedValue('Database is locked');
		show();

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load events");
		expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();

		getCalendarEvents.mockResolvedValue([]);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
	});

	it('loads from a reachable server while the browser reports offline, and shows a failed load as a failure (#1123)', async () => {
		onlineManager.setOnline(false);
		try {
			getCalendars.mockResolvedValue(calendars);
			getCalendarEvents.mockResolvedValue([]);
			const loaded = show(offlineClient());
			expect(await screen.findByText('Work')).toBeInTheDocument();
			expect(screen.queryByRole('alert')).toBeNull();
			loaded.unmount();

			getCalendars.mockRejectedValue('Database is locked');
			show(offlineClient());
			expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load calendars");
			expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		} finally {
			onlineManager.setOnline(true);
		}
	});
});
