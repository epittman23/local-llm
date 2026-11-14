import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getDailyStats, getModelAnalytics, getSummary, getTokenUsage, getUserAnalytics } from '@/lib/apis/analytics';
import { getGroups } from '@/lib/apis/groups';
import { useAuthStore } from '@/lib/stores/authStore';
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
vi.mock('./AnalyticsModelModal', () => ({
	AnalyticsModelModal: ({ open, model }: { open: boolean; model: { name: string } | null }) =>
		open && model ? <div role="dialog">Model dialog for {model.name}</div> : null
}));

beforeEach(() => {
	vi.clearAllMocks();
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
	await screen.findByText('Alpha');
};

describe('Analytics', () => {
	it('shows the totals and the model and user tables', async () => {
		await renderPage();
		expect(screen.getByText('1,234')).toBeTruthy();
		expect(screen.getByText('Beta')).toBeTruthy();
		expect(screen.getByText('Ada')).toBeTruthy();
	});

	it('opens the model dialog from a model row', async () => {
		await renderPage();
		fireEvent.click(screen.getByText('Alpha'));
		expect(await screen.findByText('Model dialog for Alpha')).toBeTruthy();
	});

	it('re-sorts the model table when a column header is clicked', async () => {
		await renderPage();
		const firstModel = () => within(screen.getAllByRole('table')[0]).getAllByRole('row')[1].textContent;
		expect(firstModel()).toContain('Alpha');
		fireEvent.click(screen.getByRole('columnheader', { name: 'Model' }));
		fireEvent.click(screen.getByRole('columnheader', { name: 'Model' }));
		expect(firstModel()).toContain('Beta');
	});

	it('shows the date inputs only for the custom period', async () => {
		await renderPage();
		expect(screen.queryByLabelText('Start date')).toBeNull();
		fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
		expect(screen.getByLabelText('Start date')).toBeTruthy();
		expect(screen.getByLabelText('End date')).toBeTruthy();
	});

	it('refetches for one group when it is picked', async () => {
		await renderPage();
		await screen.findByRole('option', { name: 'Research' });
		fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'g1' } });
		await waitFor(() => expect(getSummary).toHaveBeenLastCalledWith('tok', expect.anything(), expect.anything(), 'g1'));
	});
});
