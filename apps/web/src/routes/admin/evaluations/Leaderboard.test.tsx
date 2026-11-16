import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getLeaderboard } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { Leaderboard } from './Leaderboard';

vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/lib/apis/evaluations', () => ({ getLeaderboard: vi.fn() }));
vi.mock('./LeaderboardModal', () => ({
	LeaderboardModal: ({ open, model }: { open: boolean; model: { name: string } | null }) =>
		open ? <div data-testid="modal">{model?.name}</div> : null
}));

beforeEach(() => {
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { name: 'local-llm', version: '', features: { enable_message_rating: true } } });
	vi.mocked(getModels).mockResolvedValue([
		{ id: 'stats-tutor', name: 'Statistics tutor' },
		{ id: 'code-helper', name: 'Code helper' },
		{ id: 'never-rated', name: 'Never rated' }
	] as never);
	vi.mocked(getLeaderboard).mockResolvedValue({
		entries: [
			{ model_id: 'stats-tutor', rating: 1032, won: 6, lost: 2, count: 8 },
			{ model_id: 'code-helper', rating: 968, won: 2, lost: 6, count: 8 }
		]
	} as never);
});

const show = () =>
	render(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Leaderboard />
				</TooltipProvider>
			</QueryClientProvider>
		</MemoryRouter>
	);

describe('Leaderboard table (#1062, #1027)', () => {
	it('sits in the shared table container, labelled, so a narrow screen scrolls it in its own frame', async () => {
		show();
		const region = await screen.findByRole('region', { name: 'Leaderboard' });
		expect(region).toHaveAttribute('data-slot', 'table-container');
		// Fixed columns: the model column takes what is left, so Wins and Losses fit.
		expect(within(region).getByRole('table').className).toContain('table-fixed');
	});

	it('lists only the rated models, with words for headings and the share inline', async () => {
		show();
		const table = await screen.findByRole('table');
		expect(
			within(table)
				.getAllByRole('columnheader')
				.map((th) => th.textContent)
		).toEqual(['Rank', 'Model', 'Elo', 'Wins', 'Losses']);
		expect(within(table).queryByText('Never rated')).toBeNull();
		const row = within(table).getByRole('button', { name: 'Statistics tutor' }).closest('tr') as HTMLElement;
		const cells = within(row).getAllByRole('cell');
		expect(cells[0]).toHaveTextContent('1');
		expect(cells[3]).toHaveTextContent('6 75%');
		expect(cells[4]).toHaveTextContent('2 25%');
	});

	it('sorts from a heading button and says so with aria-sort', async () => {
		show();
		const table = await screen.findByRole('table');
		const model = within(table).getByRole('columnheader', { name: 'Model' });
		expect(model).toHaveAttribute('aria-sort', 'none');
		expect(within(table).getByRole('columnheader', { name: 'Elo' })).toHaveAttribute('aria-sort', 'descending');
		fireEvent.click(within(model).getByRole('button', { name: 'Model' }));
		expect(model).toHaveAttribute('aria-sort', 'ascending');
		const names = within(table)
			.getAllByRole('button')
			.map((b) => b.textContent)
			.filter((t) => t === 'Code helper' || t === 'Statistics tutor');
		expect(names).toEqual(['Code helper', 'Statistics tutor']);
	});

	it("opens a model's dialog from its name, a button the keyboard reaches (NAV-5)", async () => {
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Code helper' }));
		expect(screen.getByTestId('modal')).toHaveTextContent('Code helper');
	});

	it('opens it from anywhere on the row too', async () => {
		show();
		const button = await screen.findByRole('button', { name: 'Statistics tutor' });
		fireEvent.click(within(button.closest('tr') as HTMLElement).getAllByRole('cell')[2]);
		expect(screen.getByTestId('modal')).toHaveTextContent('Statistics tutor');
	});

	it('says how ratings are made when there are none (STA-3)', async () => {
		vi.mocked(getLeaderboard).mockResolvedValue({ entries: [] } as never);
		show();
		expect(await screen.findByRole('heading', { name: 'No ratings yet' })).toBeInTheDocument();
		expect(screen.getByText('Rate replies with the thumbs under a message to rank your models.')).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Turn on message rating' })).toBeNull();
		expect(screen.queryByRole('searchbox')).toBeNull();
		expect(screen.queryByLabelText('Search models')).toBeNull();
	});

	it('links to the switch while message rating is off', async () => {
		useConfigStore.setState({ config: { name: 'local-llm', version: '', features: {} } });
		vi.mocked(getLeaderboard).mockResolvedValue({ entries: [] } as never);
		show();
		const link = await screen.findByRole('link', { name: 'Turn on message rating' });
		expect(link).toHaveAttribute('href', '/admin/settings/general');
		expect(screen.getByText(/Message rating is off/)).toBeInTheDocument();
	});

	it('shows a failed load in place with Try again (STA-4)', async () => {
		vi.mocked(getLeaderboard).mockRejectedValue('Server error');
		show();
		expect(await screen.findByText("Couldn't load the leaderboard")).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});
