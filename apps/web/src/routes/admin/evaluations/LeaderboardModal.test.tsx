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
	ModelActivityChart: ({ weekly, history }: { weekly: boolean; history: unknown[] }) => (
		<div data-testid="chart">
			{weekly ? 'weekly' : 'daily'} {history.length}
		</div>
	)
}));

const MODEL: RankedModel = {
	id: 'qwen/qwen3.6-27b',
	name: 'Model One',
	rating: 1032,
	stats: { count: 3, won: 2, lost: 1 },
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
	it('starts on 30 days with a daily chart, asking for the slash id as is', async () => {
		renderModal();
		expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByTestId('chart').textContent).toContain('daily');
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'qwen/qwen3.6-27b', 30));
	});

	it('switches to a weekly chart and refetches for 1 year', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('radio', { name: '1 year' }));
		expect(screen.getByRole('radio', { name: '1 year' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByTestId('chart').textContent).toContain('weekly');
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'qwen/qwen3.6-27b', 365));
	});

	it('asks for all time with days 0', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
		await waitFor(() => expect(getModelHistory).toHaveBeenCalledWith('tok', 'qwen/qwen3.6-27b', 0));
	});

	it('lists the model top tags with their counts', () => {
		renderModal();
		expect(screen.getByText('coding')).toBeTruthy();
	});

	it('says there are no tags rather than a dash', () => {
		renderModal({ ...MODEL, top_tags: [] });
		expect(screen.getByText("No tags on this model's ratings.")).toBeInTheDocument();
	});

	it('names the model, its id, rating and record', () => {
		renderModal();
		expect(screen.getByRole('heading', { name: 'Model One' })).toBeInTheDocument();
		expect(screen.getByText('qwen/qwen3.6-27b')).toHaveClass('font-mono');
		expect(screen.getByText('qwen/qwen3.6-27b').parentElement).toHaveTextContent(
			'qwen/qwen3.6-27b · Elo 1,032 · 2 wins, 1 loss'
		);
	});

	it('shows a failed history request in place with Try again, not as no activity (#913)', async () => {
		vi.mocked(getModelHistory).mockRejectedValueOnce('Not found');
		renderModal();
		expect(await screen.findByText("Couldn't load this model's activity")).toBeInTheDocument();
		expect(screen.queryByTestId('chart')).toBeNull();
		vi.mocked(getModelHistory).mockResolvedValueOnce({ history: [{ date: '2026-11-15', won: 1, lost: 0 }] } as never);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByTestId('chart')).toHaveTextContent('daily 1');
	});

	it('closes from the Close button', () => {
		const onOpenChange = renderModal();
		fireEvent.click(
			screen.getAllByRole('button', { name: 'Close' }).find((b) => b.textContent === 'Close') as HTMLElement
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
