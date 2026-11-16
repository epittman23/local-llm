import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getDailyStats, getModelAnalytics, getSummary, getTokenUsage, getUserAnalytics } from '@/lib/apis/analytics';
import { getGroups } from '@/lib/apis/groups';
import { useAuthStore } from '@/lib/stores/authStore';
import { useAdminSingleUser } from '../adminVisibility';
import Analytics from './Analytics';

vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/lib/apis/groups', () => ({ getGroups: vi.fn() }));
vi.mock('@/lib/apis/analytics', () => ({
	getDailyStats: vi.fn(),
	getModelAnalytics: vi.fn(),
	getSummary: vi.fn(),
	getTokenUsage: vi.fn(),
	getUserAnalytics: vi.fn()
}));
vi.mock('../adminVisibility', () => ({ useAdminSingleUser: vi.fn(() => false) }));
vi.mock('./AnalyticsModelModal', () => ({
	AnalyticsModelModal: ({ open, model }: { open: boolean; model: { name: string } | null }) =>
		open && model ? <div role="dialog">Model dialog for {model.name}</div> : null
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(useAdminSingleUser).mockReturnValue(false);
	localStorage.clear();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getModels).mockResolvedValue([
		{ id: 'm1', name: 'Alpha' },
		{ id: 'm2', name: 'Beta' }
	] as never);
	vi.mocked(getGroups).mockResolvedValue([{ id: 'g1', name: 'Research' }] as never);
	vi.mocked(getSummary).mockResolvedValue({ total_messages: 1234, total_chats: 5, total_users: 2 } as never);
	vi.mocked(getModelAnalytics).mockResolvedValue({
		models: [
			{ model_id: 'm1', count: 30, unique_users: 2, unique_chats: 4 },
			{ model_id: 'm2', count: 10, unique_users: 1, unique_chats: 1 }
		]
	} as never);
	vi.mocked(getUserAnalytics).mockResolvedValue({
		users: [{ user_id: 'u1abcdefgh', name: 'Ada', count: 7, total_tokens: 900 }]
	} as never);
	vi.mocked(getDailyStats).mockResolvedValue({
		data: [
			{ date: '2026-01-01', models: { m1: 1 } },
			{ date: '2026-01-02', models: { m1: 2 } }
		]
	} as never);
	vi.mocked(getTokenUsage).mockResolvedValue({ total_tokens: 5000, models: [] } as never);
});

const renderPage = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Analytics />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole('region', { name: 'Model usage' });
};

// Radix menus open on pointer down.
const openMenu = (name: RegExp) =>
	fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, pointerType: 'mouse' });

describe('Analytics', () => {
	it('shows the totals and the model and user tables', async () => {
		await renderPage();
		expect(screen.getByText('1,234')).toBeTruthy();
		expect(screen.getByText('messages')).toBeTruthy();
		expect(screen.getByText('tokens (estimated)')).toBeTruthy();
		expect(screen.getByText('users')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
		expect(within(screen.getByRole('region', { name: 'User activity' })).getByText('Ada')).toBeTruthy();
	});

	it('says "1 user", not "1 users" (WRD-5)', async () => {
		vi.mocked(getSummary).mockResolvedValue({ total_messages: 1, total_chats: 1, total_users: 1 } as never);
		await renderPage();
		expect(screen.getByText('user')).toBeTruthy();
		expect(screen.getByText('message')).toBeTruthy();
		expect(screen.getByText('chat')).toBeTruthy();
	});

	it('opens the model dialog from a model row, and from its name button by keyboard', async () => {
		await renderPage();
		const row = screen.getByRole('button', { name: 'Beta' }).closest('tr') as HTMLElement;
		fireEvent.click(row.querySelector('td:last-child') as HTMLElement);
		expect(await screen.findByText('Model dialog for Beta')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
		expect(await screen.findByText('Model dialog for Alpha')).toBeTruthy();
	});

	it('re-sorts the model table from a column heading, marking it with aria-sort', async () => {
		await renderPage();
		const table = screen.getByRole('region', { name: 'Model usage' });
		const firstModel = () => within(table).getAllByRole('row')[1].textContent;
		expect(firstModel()).toContain('Alpha');
		fireEvent.click(within(table).getByRole('button', { name: /^Model/ }));
		expect(within(table).getAllByRole('columnheader')[0].getAttribute('aria-sort')).toBe('ascending');
		fireEvent.click(within(table).getByRole('button', { name: /^Model/ }));
		expect(firstModel()).toContain('Beta');
	});

	it('drops a provider prefix every model shares from the cell, and keeps it in the title', async () => {
		vi.mocked(getModels).mockResolvedValue([
			{ id: 'm1', name: 'qwen/qwen3.6-27b' },
			{ id: 'm2', name: 'qwen/qwen-2.5-coder' }
		] as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Analytics />
				</TooltipProvider>
			</QueryClientProvider>
		);
		const button = await screen.findByRole('button', { name: 'qwen3.6-27b' });
		expect(button.getAttribute('title')).toBe('qwen/qwen3.6-27b (m1)');
	});

	it('shows the date inputs only for the custom period, and waits for both dates', async () => {
		await renderPage();
		expect(screen.queryByLabelText('Start date')).toBeNull();
		openMenu(/^Period: Last 7 days/);
		fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Custom range' }));
		expect(screen.getByLabelText('Start date')).toBeTruthy();
		expect(screen.getByLabelText('End date')).toBeTruthy();
		expect(screen.getByText('Choose a start and an end date.')).toBeTruthy();
	});

	it('refetches for one group when it is picked', async () => {
		await renderPage();
		openMenu(/^Group: All users/);
		fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Research' }));
		await waitFor(() => expect(getSummary).toHaveBeenLastCalledWith('tok', expect.anything(), expect.anything(), 'g1'));
		expect(screen.getByRole('button', { name: /^Group: Research/ })).toBeTruthy();
	});

	it('hides users, User activity and the group filter while there is one account (S4-D1)', async () => {
		vi.mocked(useAdminSingleUser).mockReturnValue(true);
		await renderPage();
		expect(screen.queryByRole('region', { name: 'User activity' })).toBeNull();
		expect(screen.queryByRole('button', { name: /^Group:/ })).toBeNull();
		expect(screen.queryByText('users')).toBeNull();
		const table = screen.getByRole('region', { name: 'Model usage' });
		expect(within(table).queryByRole('button', { name: /^Users/ })).toBeNull();
		expect(getGroups).not.toHaveBeenCalled();
	});

	it('says in place when the figures fail to load', async () => {
		vi.mocked(getSummary).mockRejectedValue('Database is locked');
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Analytics />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load analytics");
	});

	it('says so when no model was used in the period', async () => {
		vi.mocked(getModelAnalytics).mockResolvedValue({ models: [] } as never);
		vi.mocked(getUserAnalytics).mockResolvedValue({ users: [] } as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Analytics />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect((await screen.findAllByText('No messages in this period.')).length).toBe(2);
	});

	it('draws the chart with the model names in its legend', async () => {
		await renderPage();
		const legend = screen.getByRole('list', { name: 'Legend' });
		expect(legend.textContent).toBe('Alpha');
	});
});
