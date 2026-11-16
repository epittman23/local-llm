import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { deleteFeedbackById, getFeedbackItems, getFeedbackModelIds } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { Feedbacks } from './Feedbacks';
import { feedbackResult } from './feedbackResult';

vi.mock('@/lib/apis/evaluations', () => ({
	getFeedbackItems: vi.fn(),
	getFeedbackModelIds: vi.fn(),
	deleteFeedbackById: vi.fn(),
	exportAllFeedbacks: vi.fn()
}));
vi.mock('@/routes/workspace/workspaceAccess', () => ({ useSingleUser: vi.fn(() => true) }));
vi.mock('./FeedbackModal', () => ({
	FeedbackModal: ({ open, feedback }: { open: boolean; feedback: { id: string } | null }) =>
		open ? <div data-testid="detail">{feedback?.id}</div> : null
}));

const ITEMS = [
	{
		id: 'f1',
		user: { id: 'u1', name: 'Ada Admin' },
		data: { model_id: 'qwen/qwen3.6-27b', rating: 1 },
		updated_at: 1_700_000_000
	},
	{
		id: 'f2',
		user: { id: 'u2', name: 'Ben Tester' },
		data: { model_id: 'qwen/qwen-2.5-coder-32b-instruct', rating: -1, sibling_model_ids: ['qwen/qwen3.6-27b'] },
		updated_at: 1_700_000_100
	}
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(useSingleUser).mockReturnValue(true);
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getFeedbackItems).mockResolvedValue({ items: ITEMS, total: 2 });
	vi.mocked(getFeedbackModelIds).mockResolvedValue(['qwen/qwen3.6-27b']);
});

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
		renderFeedbacks();
		// #987: the filter's name contains what it shows.
		const model = await screen.findByRole('button', { name: 'Model: All models' });
		fireEvent.pointerDown(model, { button: 0, pointerType: 'mouse' });
		fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: 'qwen/qwen3.6-27b' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
		await waitFor(() =>
			expect(getFeedbackItems).toHaveBeenLastCalledWith(expect.anything(), 'updated_at', 'desc', 1, '')
		);
		expect(screen.getByRole('heading', { name: 'No feedback yet' })).toBeVisible();
	});
});

describe('Feedbacks table (#1027, #1062)', () => {
	it('is the shared table, labelled, with an sr-only actions heading (#987)', async () => {
		renderFeedbacks();
		const region = await screen.findByRole('region', { name: 'Feedback' });
		expect(region).toHaveAttribute('data-slot', 'table-container');
		expect(
			within(region)
				.getAllByRole('columnheader')
				.map((th) => th.textContent)
		).toEqual(['Model', 'Result', 'Updated', 'Actions']);
	});

	it('reads a thumb as Up or Down and an arena comparison as Won or Lost', async () => {
		renderFeedbacks();
		await screen.findByRole('table');
		expect(screen.getByText('Up')).toBeInTheDocument();
		expect(screen.getByText('Lost')).toBeInTheDocument();
		expect(screen.getByText('Compared with qwen/qwen3.6-27b')).toBeInTheDocument();
		expect(feedbackResult({ data: { rating: 0 } })).toBeNull();
		expect(feedbackResult({ data: { rating: 0, sibling_model_ids: ['x'] } })).toBe('Draw');
		expect(feedbackResult({ data: { rating: 1, sibling_model_ids: ['x'] } })).toBe('Won');
		expect(feedbackResult({ data: null })).toBeNull();
	});

	it('shows who rated only while there is more than one account (S4-D1)', async () => {
		vi.mocked(useSingleUser).mockReturnValue(false);
		renderFeedbacks();
		const table = await screen.findByRole('table');
		expect(within(table).getByRole('columnheader', { name: 'User' })).toBeInTheDocument();
		expect(within(table).getByText('Ben Tester')).toBeInTheDocument();
		fireEvent.click(within(table).getByRole('button', { name: /^User/ }));
		await waitFor(() => expect(getFeedbackItems).toHaveBeenLastCalledWith('tok', 'user', 'asc', 1, ''));
	});

	it('opens a rating from its model name, from the keyboard (NAV-5), or from the row', async () => {
		renderFeedbacks();
		fireEvent.click(await screen.findByRole('button', { name: 'qwen/qwen3.6-27b' }));
		expect(screen.getByTestId('detail')).toHaveTextContent('f1');
	});

	it('opens a rating from a plain cell of its row', async () => {
		renderFeedbacks();
		const row = (await screen.findByRole('button', { name: 'qwen/qwen3.6-27b' })).closest('tr') as HTMLElement;
		fireEvent.click(within(row).getByText('Up'));
		expect(screen.getByTestId('detail')).toHaveTextContent('f1');
	});

	it("leaves a click on the row's menu, or in the menu it opens, to the menu", async () => {
		renderFeedbacks();
		const row = (await screen.findByRole('button', { name: 'qwen/qwen3.6-27b' })).closest('tr') as HTMLElement;
		const more = within(row).getByRole('button', { name: 'More actions' });
		fireEvent.click(more);
		fireEvent.pointerDown(more, { button: 0, pointerType: 'mouse' });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete rating' }));
		expect(screen.queryByTestId('detail')).toBeNull();
	});

	it('sorts from a heading and says so with aria-sort', async () => {
		renderFeedbacks();
		const table = await screen.findByRole('table');
		const result = within(table).getByRole('columnheader', { name: 'Result' });
		fireEvent.click(within(result).getByRole('button'));
		expect(result).toHaveAttribute('aria-sort', 'ascending');
		await waitFor(() => expect(getFeedbackItems).toHaveBeenLastCalledWith('tok', 'rating', 'asc', 1, ''));
	});

	it('asks before deleting a rating, naming it (ACT-3)', async () => {
		vi.mocked(deleteFeedbackById).mockResolvedValue(true as never);
		renderFeedbacks();
		const row = (await screen.findByRole('button', { name: 'qwen/qwen3.6-27b' })).closest('tr') as HTMLElement;
		fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions' }), {
			button: 0,
			pointerType: 'mouse'
		});
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete rating' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete this rating?' });
		expect(dialog).toHaveTextContent('The rating of qwen/qwen3.6-27b is removed');
		expect(deleteFeedbackById).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete rating' }));
		await waitFor(() => expect(deleteFeedbackById).toHaveBeenCalledWith('tok', 'f1'));
	});

	it('shows a failed load in place with Try again (STA-4)', async () => {
		vi.mocked(getFeedbackItems).mockRejectedValue('Server error');
		renderFeedbacks();
		expect(await screen.findByText("Couldn't load feedback")).toBeInTheDocument();
	});
});
