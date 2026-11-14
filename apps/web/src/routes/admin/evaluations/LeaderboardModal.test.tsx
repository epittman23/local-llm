import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModelHistory } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { LeaderboardModal } from './LeaderboardModal';
import type { RankedModel } from './leaderboard';

vi.mock('@/lib/apis/evaluations', () => ({ getModelHistory: vi.fn() }));
vi.mock('./ModelActivityChart', () => ({
	ModelActivityChart: ({ weekly }: { weekly: boolean }) => <div data-testid="chart">{weekly ? 'weekly' : 'daily'}</div>
}));

const MODEL: RankedModel = {
	id: 'm1',
	name: 'Model One',
	rating: 1000,
	stats: { count: 3, won: '2', lost: '1' },
	top_tags: [{ tag: 'coding', count: 4 }]
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getModelHistory).mockResolvedValue({ history: [] } as never);
	useAuthStore.setState({ token: 'tok' } as never);
});

const renderModal = (model: RankedModel | null = MODEL) => {
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<LeaderboardModal open onOpenChange={onOpenChange} model={model} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return onOpenChange;
};

describe('LeaderboardModal', () => {
	it('starts on the 30D range with a daily chart', async () => {
		renderModal();
		expect(screen.getByRole('button', { name: '30D' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('chart').textContent).toBe('daily');
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'm1', 30));
	});

	it('switches to a weekly chart and refetches for the 1Y range', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: '1Y' }));
		expect(screen.getByRole('button', { name: '1Y' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByRole('button', { name: '30D' }).getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByTestId('chart').textContent).toBe('weekly');
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'm1', 365));
	});

	it('asks for all time with days 0 from the All button', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'm1', 0));
	});

	it('lists the model top tags with their counts', () => {
		renderModal();
		expect(screen.getByText('coding')).toBeTruthy();
	});

	it('closes from the Close button', () => {
		const onOpenChange = renderModal();
		fireEvent.click(
			screen.getAllByRole('button', { name: 'Close' }).find((b) => b.textContent === 'Close') as HTMLElement
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
