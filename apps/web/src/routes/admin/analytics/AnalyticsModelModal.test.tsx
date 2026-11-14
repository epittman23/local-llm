import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModelChats, getModelOverview } from '@/lib/apis/analytics';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { AnalyticsModelModal } from './AnalyticsModelModal';

vi.mock('@/lib/apis/analytics', () => ({ getModelChats: vi.fn(), getModelOverview: vi.fn() }));
vi.mock('../evaluations/ModelActivityChart', () => ({
	ModelActivityChart: ({ weekly }: { weekly: boolean }) => <div data-testid="chart">{weekly ? 'weekly' : 'daily'}</div>
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getModelOverview).mockResolvedValue({ history: [], tags: [{ tag: 'math', count: 5 }] } as never);
	vi.mocked(getModelChats).mockResolvedValue({
		chats: [{ chat_id: 'c1', first_message: 'Hello there', updated_at: 1700000000, user_id: 'u', user_name: 'Ada' }],
		total: 1
	} as never);
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { features: { enable_admin_chat_access: true } } } as never);
});

const renderModal = () => {
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<TooltipProvider>
					<AnalyticsModelModal
						open
						onOpenChange={onOpenChange}
						model={{ id: 'm1', name: 'Model One' }}
						startDate={10}
						endDate={20}
					/>
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
	return onOpenChange;
};

describe('AnalyticsModelModal', () => {
	it('opens on Overview with the model tags', async () => {
		renderModal();
		expect(await screen.findByText('math')).toBeTruthy();
		expect(screen.getByTestId('chart').textContent).toBe('daily');
	});

	it('switches the chart to weekly and refetches when the range changes', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: '1Y' }));
		expect(screen.getByRole('button', { name: '1Y' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('chart').textContent).toBe('weekly');
		await waitFor(() => expect(getModelOverview).toHaveBeenCalledWith('tok', 'm1', 365));
	});

	it('loads the chats of the model when the Chats tab is opened', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
		expect(await screen.findByText('Hello there')).toBeTruthy();
		expect(getModelChats).toHaveBeenCalledWith('tok', 'm1', 10, 20, 0, 50, 'updated_at', 'desc');
		fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
		expect(screen.getByTestId('chart')).toBeTruthy();
	});

	it('has no Chats tab when admins may not read chats', () => {
		useConfigStore.setState({ config: { features: { enable_admin_chat_access: false } } } as never);
		renderModal();
		expect(screen.queryByRole('button', { name: 'Chats' })).toBeNull();
	});

	it('closes from the Close button', () => {
		const onOpenChange = renderModal();
		fireEvent.click(
			screen.getAllByRole('button', { name: 'Close' }).find((b) => b.textContent === 'Close') as HTMLElement
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
