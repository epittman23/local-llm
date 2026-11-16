import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { getModelHistory } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import type { ActivityDay } from './activityChart';
import { figure, type RankedModel } from './leaderboard';
import { ModelActivityChart } from './ModelActivityChart';

type Range = '30d' | '1y' | 'all';
// days = 0 means all time, starting from the first feedback.
const RANGES: { value: Range; label: string; days: number }[] = [
	{ value: '30d', label: '30 days', days: 30 },
	{ value: '1y', label: '1 year', days: 365 },
	{ value: 'all', label: 'All time', days: 0 }
];

/**
 * Ports Evaluations/LeaderboardModal.svelte: one model's activity chart
 * (30 days / 1 year / all time) and its top tags.
 *
 * A request that fails says so in place, with Try again (STA-4, #913); only
 * an answer with no ratings reads "No ratings in this period".
 */
export function LeaderboardModal({
	open,
	onOpenChange,
	model
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	model: RankedModel | null;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [range, setRange] = useState<Range>('30d');
	// Each open starts on 30 days, as the original's reactive block does.
	const modelId = model?.id;
	useEffect(() => {
		if (open && modelId) setRange('30d');
	}, [open, modelId]);

	const days = RANGES.find((r) => r.value === range)?.days ?? 30;
	const history = useQuery({
		queryKey: ['admin', 'model-history', modelId, days],
		queryFn: async () => ((await getModelHistory(token, modelId ?? '', days))?.history ?? []) as ActivityDay[],
		enabled: open && !!modelId
	});

	if (!model) return null;
	const { won, lost } = model.stats;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="truncate" title={model.name}>
						{model.name}
					</DialogTitle>
					<DialogDescription className="tabular-nums">
						<span className="font-mono break-all">{model.id}</span> · Elo {figure(model.rating)} · {figure(won)}{' '}
						{won === 1 ? 'win' : 'wins'}, {figure(lost)} {lost === 1 ? 'loss' : 'losses'}
					</DialogDescription>
				</DialogHeader>

				<section aria-labelledby="leaderboard-activity" className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 id="leaderboard-activity" className="text-body font-strong">
							Activity
						</h3>
						<SegmentedControl aria-label="Period" value={range} onValueChange={setRange} options={RANGES} />
					</div>
					{history.isError ? (
						<LoadFailed
							what="this model's activity"
							error={history.error}
							onRetry={() => history.refetch()}
							retrying={history.isFetching}
						/>
					) : (
						<ModelActivityChart
							history={history.data ?? []}
							loading={history.isPending}
							weekly={range === '1y' || range === 'all'}
						/>
					)}
				</section>

				<section aria-labelledby="leaderboard-tags" className="flex flex-col gap-2">
					<h3 id="leaderboard-tags" className="text-body font-strong">
						Top tags
					</h3>
					{model.top_tags.length ? (
						<ul className="flex flex-wrap gap-1">
							{model.top_tags.map((t) => (
								<li key={t.tag}>
									<Badge variant="secondary">
										{t.tag} <span className="text-foreground-muted tabular-nums">{t.count}</span>
									</Badge>
								</li>
							))}
						</ul>
					) : (
						<p className="text-foreground-muted">No tags on this model's ratings.</p>
					)}
				</section>

				<div className="flex justify-end">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
