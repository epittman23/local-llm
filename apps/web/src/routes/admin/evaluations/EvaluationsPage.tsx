import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { getModels } from '@/lib/apis';
import { getFeedbackItems, getLeaderboard } from '@/lib/apis/evaluations';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatNumber } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { SubTabs } from '../AdminLayout';
import { tabFromPath } from '../adminAccess';
import { Feedbacks } from './Feedbacks';
import { Leaderboard } from './Leaderboard';
import { type LeaderboardEntry, type ModelInfo, leaderboardCount } from './leaderboard';

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
			getFeedbackItems(token, 'updated_at', 'desc', 1).catch(() => null),
			getModels(token).catch(() => null)
		]).then(([board, feedback, models]) => {
			if (cancelled) return;
			setCount('leaderboard', leaderboardCount((models ?? []) as ModelInfo[], (board?.entries ?? []) as LeaderboardEntry[]));
			setCount('feedback', feedback?.total ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [token, setCount]);

	return (
		<div className="flex h-full w-full flex-col pb-2 lg:flex-row lg:space-x-4">
			<SubTabs
				active={tab}
				tabs={[
					{ id: 'leaderboard', to: routePaths.adminEvaluationsLeaderboard, label: 'Leaderboard', count: counts.leaderboard === null ? null : formatNumber(counts.leaderboard) },
					{ id: 'feedback', to: routePaths.adminEvaluationsFeedback, label: 'Feedback', count: counts.feedback === null ? null : formatNumber(counts.feedback) }
				]}
			/>
			<div className="mt-1 flex-1 overflow-y-scroll px-4 lg:mt-0 lg:pr-4 lg:pl-0">{tab === 'leaderboard' ? <Leaderboard /> : <Feedbacks />}</div>
		</div>
	);
}
