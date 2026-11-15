import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getFeedbackItems, getFeedbackModelIds } from '@/lib/apis/evaluations';
import { Feedbacks } from './Feedbacks';

vi.mock('@/lib/apis/evaluations', () => ({
	getFeedbackItems: vi.fn(),
	getFeedbackModelIds: vi.fn(),
	deleteFeedbackById: vi.fn(),
	exportAllFeedbacks: vi.fn()
}));

const renderFeedbacks = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Feedbacks />
			</TooltipProvider>
		</QueryClientProvider>
	);

describe('Feedbacks empty states (STA-3)', () => {
	it('says what belongs here with no feedback at all', async () => {
		vi.mocked(getFeedbackItems).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(getFeedbackModelIds).mockResolvedValue([]);
		renderFeedbacks();
		expect(await screen.findByRole('heading', { name: 'No feedback yet' })).toBeVisible();
		expect(screen.getByText('The ratings you give replies in chat appear here.')).toBeVisible();
	});

	it('says a model filter matched nothing and clears it', async () => {
		vi.mocked(getFeedbackItems).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(getFeedbackModelIds).mockResolvedValue(['qwen/qwen3.6-27b']);
		renderFeedbacks();
		const model = await screen.findByRole('button', { name: 'Model' });
		fireEvent.pointerDown(model, { button: 0, pointerType: 'mouse' });
		fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: 'qwen/qwen3.6-27b' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
		await waitFor(() =>
			expect(getFeedbackItems).toHaveBeenLastCalledWith(expect.anything(), 'updated_at', 'desc', 1, '')
		);
		expect(screen.getByRole('heading', { name: 'No feedback yet' })).toBeVisible();
	});
});
