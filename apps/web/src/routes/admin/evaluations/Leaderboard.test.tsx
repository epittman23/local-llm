import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getLeaderboard } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { Leaderboard } from './Leaderboard';

vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/lib/apis/evaluations', () => ({ getLeaderboard: vi.fn() }));
vi.mock('./LeaderboardModal', () => ({ LeaderboardModal: () => null }));

beforeEach(() => {
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getModels).mockResolvedValue([
		{ id: 'stats-tutor', name: 'Statistics tutor' },
		{ id: 'code-helper', name: 'Code helper' }
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
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Leaderboard />
			</TooltipProvider>
		</QueryClientProvider>
	);

describe('Leaderboard table (#1062)', () => {
	it('sits in the shared table container, labelled, so a narrow screen scrolls it in its own frame', async () => {
		show();
		const table = await screen.findByRole('table', { name: 'Leaderboard' });
		expect(table.parentElement).toHaveAttribute('data-slot', 'table-container');
		expect(table.className).toContain('whitespace-nowrap');
		expect(await screen.findByText('Statistics tutor')).toBeInTheDocument();
	});
});
