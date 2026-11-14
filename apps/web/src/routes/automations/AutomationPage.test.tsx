import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
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

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis/automations', () => api);
vi.mock('@/lib/apis', () => ({ getModels: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('./useDestinations', () => ({ useDestinations: () => ({ folders: [], channels: [], loaded: true }) }));

const automation = (extra = {}) => ({
	id: 'a1',
	name: 'Digest',
	folder_id: null,
	is_active: true,
	last_run_at: null,
	next_run_at: null,
	data: { prompt: 'Summarise the news', model_id: 'm1', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
	...extra
});

const open = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/automations/a1']}>
					<Routes>
						<Route path="/automations/:id" element={<AutomationPage />} />
						<Route path="/automations" element={<div>list</div>} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	vi.resetAllMocks();
	api.getAutomationById.mockResolvedValue(automation());
	api.getAutomationRuns.mockResolvedValue([
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
			error: 'boom',
			created_at: 1_700_000_100_000_000_000
		}
	]);
	api.getAutomationItems.mockResolvedValue({ items: [], total: 3 });
});

describe('an automation page', () => {
	it('shows an active status and a run list with success and error markers', async () => {
		open();
		expect(await screen.findByText('Active')).toBeInTheDocument();
		expect(await screen.findByLabelText('success')).toBeInTheDocument();
		expect(screen.getByLabelText('error')).toBeInTheDocument();
		expect(screen.getByText('boom')).toBeInTheDocument();
	});

	it('shows a paused status for an inactive automation', async () => {
		api.getAutomationById.mockResolvedValue(automation({ is_active: false }));
		open();
		expect(await screen.findByText('Paused')).toBeInTheDocument();
	});

	it('runs the automation now from the header button', async () => {
		api.runAutomationById.mockResolvedValue({});
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
		await waitFor(() => expect(api.runAutomationById).toHaveBeenCalledWith('t', 'a1'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Automation triggered'));
	});

	it('opens the edit dialog from the Edit button', async () => {
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
		expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
	});

	it('deletes after confirmation and returns to the list', async () => {
		api.deleteAutomationById.mockResolvedValue({});
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		expect(await screen.findByText('Delete automation?')).toBeInTheDocument();
		const confirm = screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement;
		fireEvent.click(confirm);
		await waitFor(() => expect(api.deleteAutomationById).toHaveBeenCalledWith('t', 'a1'));
		expect(await screen.findByText('list')).toBeInTheDocument();
	});
});
