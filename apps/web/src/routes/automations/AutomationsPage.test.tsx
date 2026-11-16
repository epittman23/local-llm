import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AutomationsPage } from './AutomationsPage';

const api = vi.hoisted(() => ({
	createAutomation: vi.fn(),
	deleteAutomationById: vi.fn(),
	getAutomationItems: vi.fn(),
	runAutomationById: vi.fn(),
	toggleAutomationById: vi.fn(),
	updateAutomationById: vi.fn()
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis/automations', () => api);
vi.mock('@/lib/apis', () => ({ getModels: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('./useDestinations', () => ({ useDestinations: () => ({ folders: [], channels: [], loaded: true }) }));

const ago = (minutes: number) => (Date.now() - minutes * 60_000) * 1_000_000;
const item = (extra = {}) => ({
	id: 'a1',
	name: 'Morning digest',
	folder_id: null,
	is_active: true,
	last_run_at: null,
	next_run_at: null,
	last_run: null,
	next_runs: null,
	data: { prompt: 'p', model_id: 'm', rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30' },
	...extra
});

const open = () => {
	const router = createMemoryRouter(
		[
			{ path: '/automations', element: <AutomationsPage /> },
			{ path: '/automations/:id', element: <div>automation page</div> }
		],
		{ initialEntries: ['/automations'] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
};

beforeEach(() => vi.resetAllMocks());

describe('the Automations page (LAY-5, #1040)', () => {
	it('opens with its h1, what it is for, and New automation', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [], total: 0 });
		open();
		expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'New automation' })[0]).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Status: All' })).toBeInTheDocument();
		expect(await screen.findByText('No automations yet')).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole('button', { name: 'New automation' })[1]);
		expect(await screen.findByRole('heading', { name: 'New automation', level: 2 })).toBeInTheDocument();
	});
});

describe('a row (#915, #964)', () => {
	it('shows the last run from the server: its badge, its time, and a failure in words', async () => {
		api.getAutomationItems.mockResolvedValue({
			items: [
				item({
					last_run: {
						id: 'r',
						automation_id: 'a1',
						chat_id: null,
						status: 'error',
						error: 'Model overloaded',
						created_at: ago(12)
					}
				}),
				item({
					id: 'a2',
					name: 'Weekly review',
					is_active: false,
					last_run: { id: 's', automation_id: 'a2', chat_id: 'c', status: 'success', error: null, created_at: ago(180) }
				}),
				item({ id: 'a3', name: 'Fresh' })
			],
			total: 3
		});
		open();
		const [failed, ok, fresh] = (await screen.findAllByRole('listitem')).map((li) => within(li));
		expect(failed.getByText('Failed')).toBeInTheDocument();
		expect(failed.getByText('12 minutes ago')).toBeInTheDocument();
		expect(failed.getByRole('button', { name: /Morning digest.*Failed.*Model overloaded/ })).toBeInTheDocument();
		expect(failed.getByText('Mon, Wed, Fri at 7:30 AM · New chat')).toBeInTheDocument();
		expect(ok.getByText('Succeeded')).toBeInTheDocument();
		expect(ok.getByText('Paused')).toBeInTheDocument();
		expect(fresh.getByText('Never run')).toBeInTheDocument();
		// LAY-4: the row can shrink, so its menu and switch stay on screen.
		expect(screen.getAllByRole('listitem')[0]).toHaveClass('min-w-0');
	});

	it('runs now from its menu, and looks at the list again', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		api.runAutomationById.mockResolvedValue({});
		open();
		fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for Morning digest' }), {
			button: 0,
			ctrlKey: false
		});
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Run now' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Morning digest is running'));
		await waitFor(() => expect(api.getAutomationItems.mock.calls.length).toBeGreaterThan(2));
	});

	it('pauses from its switch, and says so when that fails', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		api.toggleAutomationById.mockRejectedValue('Server busy');
		open();
		fireEvent.click(await screen.findByRole('switch', { name: 'Run Morning digest on its schedule' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error.mock.calls[0][0]).toBe("Couldn't pause Morning digest");
	});

	it('opens the automation', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		open();
		fireEvent.click(await screen.findByRole('button', { name: /^Morning digest/ }));
		expect(await screen.findByText('automation page')).toBeInTheDocument();
	});
});

describe('an Automations list that cannot load (STA-4, #981)', () => {
	it('shows the failure in place of the list, with no toast, and tries again', async () => {
		api.getAutomationItems.mockRejectedValue('Database is locked');
		open();
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load automations");
		expect(screen.queryByText('No automations yet')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		api.getAutomationItems.mockResolvedValue({ items: [], total: 0 });
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('No automations yet')).toBeInTheDocument();
	});

	it('says nothing matches a search, and clears it', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [], total: 0 });
		open();
		fireEvent.change(screen.getByLabelText('Search automations'), { target: { value: 'zebra' } });
		expect(await screen.findByText('Nothing matches “zebra”')).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' }).at(-1) as HTMLElement);
		expect(await screen.findByText('No automations yet')).toBeInTheDocument();
	});
});

describe('the list actions', () => {
	const openMenu = async (name: string) =>
		fireEvent.pointerDown(await screen.findByRole('button', { name }), { button: 0, ctrlKey: false });

	it('deletes after a confirmation that names what goes', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		api.deleteAutomationById.mockResolvedValue(true);
		open();
		await openMenu('More actions for Morning digest');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		expect(await screen.findByText(/and its run history are deleted/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete automation' }));
		await waitFor(() => expect(api.deleteAutomationById).toHaveBeenCalledWith('t', 'a1'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted Morning digest'));
	});

	it('says so when a delete fails', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		api.deleteAutomationById.mockRejectedValue('Server busy');
		open();
		await openMenu('More actions for Morning digest');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete automation' }));
		await waitFor(() => expect(toast.error.mock.calls[0]?.[0]).toBe("Couldn't delete Morning digest"));
	});

	it('duplicates one into a new automation', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [item()], total: 1 });
		open();
		await openMenu('More actions for Morning digest');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
		expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Morning digest (Clone)');
	});

	it('resumes or pauses every automation shown, and counts them', async () => {
		api.getAutomationItems.mockResolvedValue({
			items: [item(), item({ id: 'a2', name: 'Weekly', is_active: false })],
			total: 2
		});
		api.toggleAutomationById.mockResolvedValue({});
		open();
		await openMenu('Actions');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause all' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 automation paused'));
		expect(api.toggleAutomationById).toHaveBeenCalledWith('t', 'a1');
		await openMenu('Actions');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Resume all' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 automation resumed'));
	});

	it('filters by status, says how many match, and clears the filter', async () => {
		api.getAutomationItems.mockImplementation(async (_t: string, _q: string | null, status: string) =>
			status === 'paused' ? { items: [], total: 0 } : { items: [item()], total: 1 }
		);
		open();
		await openMenu('Status: All');
		fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Paused' }));
		expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('0 of 1 automations');
		// The header's badge keeps the whole count while a filter narrows the list (DAT-2, #1040).
		const heading = screen.getByRole('heading', { level: 1, name: 'Automations' });
		expect(heading.nextElementSibling).toHaveTextContent(/^1 automation$/);
		fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		expect(await screen.findByRole('button', { name: /^Morning digest/ })).toBeInTheDocument();
	});

	it('imports a file, and says when it cannot read one', async () => {
		api.getAutomationItems.mockResolvedValue({ items: [], total: 0 });
		api.createAutomation.mockResolvedValue({ id: 'n' });
		open();
		const input = screen.getByLabelText('Import automations file') as HTMLInputElement;
		const file = (text: string) => ({ text: async () => text }) as unknown as File;
		fireEvent.change(input, {
			target: {
				files: [file(JSON.stringify([{ name: 'A', data: { prompt: 'p', model_id: 'm', rrule: 'RRULE:FREQ=DAILY' } }]))]
			}
		});
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 automation'));
		fireEvent.change(input, { target: { files: [file('not json')] } });
		await waitFor(() => expect(toast.error.mock.calls[0]?.[0]).toBe("Couldn't read that file as automations"));
	});
});
