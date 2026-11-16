import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AutomationPage } from './AutomationPage';

const api = vi.hoisted(() => ({
	deleteAutomationById: vi.fn(),
	getAutomationById: vi.fn(),
	getAutomationRuns: vi.fn(),
	runAutomationById: vi.fn(),
	toggleAutomationById: vi.fn(),
	getAutomationItems: vi.fn(),
	createAutomation: vi.fn(),
	updateAutomationById: vi.fn()
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const channelsAccess = vi.hoisted(() => ({ value: 'shown' as 'shown' | 'hidden' | 'unknown' }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis/automations', () => api);
vi.mock('@/lib/apis', () => ({ getModels: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('@/routes/channels/useChannels', () => ({ useChannelsAccess: () => channelsAccess.value }));
vi.mock('./useDestinations', () => ({ useDestinations: () => ({ folders: [], channels: [], loaded: true }) }));

const automation = (extra = {}) => ({
	id: 'a1',
	name: 'Digest',
	folder_id: null,
	is_active: true,
	last_run_at: null,
	next_run_at: null,
	next_runs: [new Date(2026, 10, 19, 9, 0).getTime() * 1_000_000],
	last_run: null,
	data: { prompt: 'Summarise the news', model_id: 'm1', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
	...extra
});

const open = () => {
	const router = createMemoryRouter(
		[
			{ path: '/automations/:id', element: <AutomationPage /> },
			{ path: '/automations', element: <div>list</div> },
			{ path: '/c/:id', element: <div>chat page</div> }
		],
		{ initialEntries: ['/automations/a1'] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
};

const runs = [
	{
		id: 'r1',
		automation_id: 'a1',
		chat_id: 'chat-1',
		status: 'success',
		error: null,
		created_at: 1_700_000_000_000_000_000
	},
	{
		id: 'r2',
		automation_id: 'a1',
		chat_id: null,
		status: 'error',
		error: 'The upstream model is overloaded (try again in a few minutes); the request id was 4f1c-very-long',
		created_at: 1_700_000_100_000_000_000
	},
	{
		id: 'r3',
		automation_id: 'a1',
		chat_id: 'channel:c9',
		status: 'success',
		error: null,
		created_at: 1_700_000_200_000_000_000
	}
];

beforeEach(() => {
	vi.resetAllMocks();
	channelsAccess.value = 'shown';
	api.getAutomationById.mockResolvedValue(automation());
	api.getAutomationRuns.mockResolvedValue(runs);
	api.getAutomationItems.mockResolvedValue({ items: [], total: 3 });
});

describe('an automation page', () => {
	it('opens with its name as the h1, its schedule and destination, and its next runs', async () => {
		open();
		const h1 = await screen.findByRole('heading', { level: 1, name: 'Digest' });
		// Shortened with a pointer, whole in its Tip; wrapped on touch, where no Tip opens (#1040).
		expect(h1).toHaveClass('truncate', 'pointer-coarse:whitespace-normal', 'pointer-coarse:overflow-visible');
		expect(screen.getAllByText('Daily at 9:00 AM · New chat')).toHaveLength(1);
		expect(screen.getByText(/^Thu, Nov 19, 9:00 AM/)).toBeInTheDocument();
		expect(screen.getByText('Active')).toBeInTheDocument();
		expect(screen.getByText('Summarise the news')).toBeInTheDocument();
	});

	it('shows each run as a badge, with the whole error, Run again, and Open chat (#1034)', async () => {
		api.runAutomationById.mockResolvedValue({});
		open();
		const list = (await screen.findAllByRole('listitem')).map((li) => within(li));
		expect(list[0].getByText('Succeeded')).toBeInTheDocument();
		expect(list[0].getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', '/c/chat-1');
		expect(list[1].getByText('Failed')).toBeInTheDocument();
		expect(list[1].getByText(runs[1].error as string)).toBeInTheDocument();
		expect(list[2].getByRole('link', { name: 'Open channel' })).toHaveAttribute('href', '/channels/c9');
		fireEvent.click(list[1].getByRole('button', { name: 'Run again' }));
		await waitFor(() => expect(api.runAutomationById).toHaveBeenCalledWith('t', 'a1'));
	});

	it('says a channel run cannot be opened while Channels are hidden, instead of linking to Not found (S6-D1)', async () => {
		channelsAccess.value = 'hidden';
		open();
		const list = (await screen.findAllByRole('listitem')).map((li) => within(li));
		expect(list[0].getByRole('link', { name: 'Open chat' })).toBeInTheDocument();
		expect(list[2].queryByRole('link', { name: 'Open channel' })).toBeNull();
		expect(
			list[2].getByText('Posted to a channel. Channels are off, or this server has one account.')
		).toBeInTheDocument();
	});

	it('shows the last run from the server, not only the scheduler (#915)', async () => {
		api.getAutomationById.mockResolvedValue(automation({ last_run: runs[1] }));
		open();
		const row = (await screen.findByText('Last run')).parentElement as HTMLElement;
		expect(within(row).getByText('Failed')).toBeInTheDocument();
		expect(within(row).queryByText('Never')).toBeNull();
	});

	it('shows a paused status for an inactive automation, with no next runs', async () => {
		api.getAutomationById.mockResolvedValue(automation({ is_active: false }));
		open();
		expect(await screen.findByText('Paused')).toBeInTheDocument();
		expect(screen.getByText('None while paused')).toBeInTheDocument();
	});

	it('runs now, and looks at the automation again, not only its runs', async () => {
		api.runAutomationById.mockResolvedValue({});
		open();
		await screen.findByRole('heading', { level: 1, name: 'Digest' });
		expect(api.getAutomationById).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Digest is running'));
		await waitFor(() => expect(api.getAutomationById).toHaveBeenCalledTimes(2));
	});

	it('says a failed run-now in words', async () => {
		api.runAutomationById.mockRejectedValue('Server busy');
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error.mock.calls[0][0]).toBe("Couldn't run the automation");
	});

	it('opens the edit dialog from the Edit button', async () => {
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
		expect(await screen.findByRole('button', { name: 'Save changes' })).toBeInTheDocument();
	});

	it('pauses from the switch', async () => {
		api.toggleAutomationById.mockResolvedValue(automation({ is_active: false }));
		open();
		fireEvent.click(await screen.findByRole('switch', { name: 'Run on its schedule' }));
		await waitFor(() => expect(api.toggleAutomationById).toHaveBeenCalledWith('t', 'a1'));
	});

	it('deletes after confirmation and returns to the list', async () => {
		api.deleteAutomationById.mockResolvedValue({});
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete automation' }));
		await waitFor(() => expect(api.deleteAutomationById).toHaveBeenCalledWith('t', 'a1'));
		expect(await screen.findByText('list')).toBeInTheDocument();
	});

	it('says in place that an automation is gone (NAV-3)', async () => {
		api.getAutomationById.mockRejectedValue("We could not find what you're looking for :/");
		open();
		expect(await screen.findByRole('heading', { name: 'This automation no longer exists' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to automations' })).toHaveAttribute('href', '/automations');
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('offers to try again when it cannot load (STA-4)', async () => {
		api.getAutomationById.mockRejectedValue('Database is locked');
		open();
		expect(await screen.findByText("Couldn't load this automation")).toBeInTheDocument();
	});
});
