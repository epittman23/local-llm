import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFeedbackItems, getLeaderboard } from '@/lib/apis/evaluations';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { EvaluationsPage } from './EvaluationsPage';

vi.mock('@/lib/apis/evaluations', () => ({ getFeedbackItems: vi.fn(), getLeaderboard: vi.fn() }));
vi.mock('./Leaderboard', () => ({ Leaderboard: () => <div>leaderboard panel</div> }));
vi.mock('./Feedbacks', () => ({ Feedbacks: () => <div>feedback panel</div> }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getLeaderboard).mockResolvedValue({ entries: [] } as never);
	vi.mocked(getFeedbackItems).mockResolvedValue({ items: [], total: 7 } as never);
});

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/admin/evaluations/*" element={<EvaluationsPage />} />
			</Routes>
		</MemoryRouter>
	);

describe('EvaluationsPage', () => {
	it('shows the Leaderboard tab by default, with both sub-tabs', () => {
		renderAt(routePaths.adminEvaluationsLeaderboard);
		expect(screen.getByText('leaderboard panel')).toBeTruthy();
		expect(screen.getByRole('navigation', { name: 'Evaluations sections' })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Leaderboard/ })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Feedback/ })).toBeTruthy();
	});

	it('shows Feedback at its address, and seeds the tab counts', async () => {
		renderAt(routePaths.adminEvaluationsFeedback);
		expect(screen.getByText('feedback panel')).toBeTruthy();
		await waitFor(() => expect(useAdminStore.getState().counts.feedback).toBe(7));
		expect(screen.getByRole('link', { name: /Feedback/ })).toHaveTextContent('7');
	});

	it('leaves a count blank when its load fails', async () => {
		vi.mocked(getLeaderboard).mockRejectedValue('nope');
		renderAt(routePaths.adminEvaluationsLeaderboard);
		await waitFor(() => expect(getFeedbackItems).toHaveBeenCalled());
		await waitFor(() => expect(useAdminStore.getState().counts.leaderboard).toBeNull());
	});
});
