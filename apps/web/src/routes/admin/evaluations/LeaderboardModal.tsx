import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getModelHistory } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import type { ActivityDay } from './activityChart';
import type { RankedModel } from './leaderboard';
import { ModelActivityChart } from './ModelActivityChart';

type Range = '30d' | '1y' | 'all';
// days = 0 means all time, starting from the first feedback.
const RANGES: { key: Range; label: string; days: number }[] = [
	{ key: '30d', label: '30D', days: 30 },
	{ key: '1y', label: '1Y', days: 365 },
	{ key: 'all', label: 'All', days: 0 }
];

/** Ports Evaluations/LeaderboardModal.svelte: one model's activity chart (30D / 1Y / All) and its top tags. */
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
	// Each open starts on 30D, as the original's reactive block does.
	useEffect(() => {
		if (open) setRange('30d');
	}, [open, model?.id]);

	const days = RANGES.find((r) => r.key === range)!.days;
	const history = useQuery({
		queryKey: ['admin', 'model-history', model?.id, days],
		queryFn: async () => ((await getModelHistory(token, model!.id, days))?.history ?? []) as ActivityDay[],
		enabled: open && !!model?.id
	});

	if (!model) return null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<Tip content={`${model.name} (${model.id})`} side="top">
						<DialogTitle className="line-clamp-1 text-sm font-medium">{model.name}</DialogTitle>
					</Tip>
					<DialogDescription className="sr-only">Activity and tags for {model.name}.</DialogDescription>
				</DialogHeader>

				<div>
					<div className="mb-2 flex items-center justify-between">
						<div className="text-muted-foreground text-xs font-normal tracking-wide uppercase">Activity</div>
						<div className="bg-muted inline-flex rounded-full p-0.5">
							{RANGES.map((r) => (
								<button
									key={r.key}
									type="button"
									aria-pressed={range === r.key}
									className={cn(
										'rounded-full px-2.5 py-0.5 text-xs font-normal transition-all',
										range === r.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
									)}
									onClick={() => setRange(r.key)}
								>
									{r.label}
								</button>
							))}
						</div>
					</div>
					<ModelActivityChart history={history.data ?? []} loading={history.isPending} weekly={range === '1y' || range === 'all'} />
				</div>

				<div>
					<div className="text-muted-foreground mb-2 text-xs font-normal tracking-wide uppercase">Tags</div>
					{model.top_tags.length ? (
						<div className="-mx-1 flex flex-wrap gap-1">
							{model.top_tags.map((t) => (
								<span key={t.tag} className="bg-muted rounded-full px-2 py-0.5 text-xs">
									{t.tag} <span className="text-muted-foreground font-normal">{t.count}</span>
								</span>
							))}
						</div>
					) : (
						<span className="text-muted-foreground text-sm">-</span>
					)}
				</div>

				<div className="flex justify-end pt-2">
					<Button size="sm" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
