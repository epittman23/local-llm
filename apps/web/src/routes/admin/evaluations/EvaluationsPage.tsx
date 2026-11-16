import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { getFeedbackItems, getLeaderboard } from '@/lib/apis/evaluations';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatNumber } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { SubTabs } from '../AdminLayout';
import { tabFromPath } from '../adminAccess';
import { Feedbacks } from './Feedbacks';
import { Leaderboard } from './Leaderboard';
import { type LeaderboardEntry, leaderboardCount } from './leaderboard';

const TABS = ['leaderboard', 'feedback'] as const;

/** Ports admin/Evaluations.svelte: the Leaderboard / Feedback sub-tabs with counts. */
export function EvaluationsPage() {
	const { pathname } = useLocation();
	const token = useAuthStore((s) => s.token) ?? '';
	const counts = useAdminStore((s) => s.counts);
	const setCount = useAdminStore((s) => s.setCount);
	const tab = tabFromPath(pathname, TABS);

	// Seeds both counts so the inactive tab is not blank; each panel then keeps its own current.
	useEffect(() => {
		let cancelled = false;
		Promise.all([
			getLeaderboard(token).catch(() => null),
			getFeedbackItems(token, 'updated_at', 'desc', 1).catch(() => null)
		]).then(([board, feedback]) => {
			if (cancelled) return;
			setCount('leaderboard', board ? leaderboardCount((board.entries ?? []) as LeaderboardEntry[]) : null);
			setCount('feedback', feedback?.total ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [token, setCount]);

	return (
		<div className="flex w-full flex-col pb-2">
			<SubTabs
				active={tab}
				tabs={[
					{
						id: 'leaderboard',
						to: routePaths.adminEvaluationsLeaderboard,
						label: 'Leaderboard',
						count: counts.leaderboard === null ? null : formatNumber(counts.leaderboard)
					},
					{
						id: 'feedback',
						to: routePaths.adminEvaluationsFeedback,
						label: 'Feedback',
						count: counts.feedback === null ? null : formatNumber(counts.feedback)
					}
				]}
			/>
			<div className="min-w-0 flex-1 px-4 pt-3">{tab === 'leaderboard' ? <Leaderboard /> : <Feedbacks />}</div>
		</div>
	);
}
