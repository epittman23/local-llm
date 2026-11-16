import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Table, TableRow, TableSortHead } from '@/components/ui/table';
import { getModels } from '@/lib/apis';
import { getLeaderboard } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { LeaderboardModal } from './LeaderboardModal';
import {
	buildRankedModels,
	figure,
	type LeaderboardEntry,
	type LeaderboardSort,
	type ModelInfo,
	percentOf,
	type RankedModel,
	rankById,
	sortRanked
} from './leaderboard';

/** The figures' columns; a phone shows them on the model's second line instead (DAT-6). */
const FIGURES: { key: LeaderboardSort; label: string; className: string }[] = [
	{ key: 'rating', label: 'Elo', className: 'w-20' },
	{ key: 'won', label: 'Wins', className: 'w-28' },
	{ key: 'lost', label: 'Losses', className: 'w-28' }
];

/** "6 75%": the count, with its share of decided games beside it, never only on hover (A11Y-4). */
function Record({ value, count }: { value: number; count: number }) {
	return (
		<>
			{figure(value)} <span className="text-foreground-muted">{percentOf(value, count)}%</span>
		</>
	);
}

/**
 * Ports Evaluations/Leaderboard.svelte: the rated models with their Elo
 * rating and record, searchable (500 ms debounce, server-side) and sortable.
 * A row opens the model's activity and tags, by pointer or from its name
 * (a button, so Tab and Enter reach it, NAV-5).
 *
 * Only models with ratings are listed (#1027): an unrated model has no place
 * in a ranking. The empty board says how ratings are made, and, while
 * message rating is off (the default), where to turn it on.
 */
export function Leaderboard() {
	const token = useAuthStore((s) => s.token) ?? '';
	const setCount = useAdminStore((s) => s.setCount);
	const ratingOn = useConfigStore((s) => s.config?.features?.enable_message_rating === true);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 500);
	const [orderBy, setOrderBy] = useState<LeaderboardSort>('rating');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [selected, setSelected] = useState<RankedModel | null>(null);
	const [showModal, setShowModal] = useState(false);

	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[]
	});
	const board = useQuery({
		queryKey: ['admin', 'leaderboard', debouncedQuery],
		queryFn: async () => ((await getLeaderboard(token, debouncedQuery))?.entries ?? []) as LeaderboardEntry[]
	});

	const ranked = useMemo(() => buildRankedModels(models.data ?? [], board.data ?? []), [models.data, board.data]);
	const ranks = useMemo(() => rankById(ranked), [ranked]);
	const sorted = useMemo(() => sortRanked(ranked, orderBy, direction), [ranked, orderBy, direction]);
	const searching = board.isFetching || debouncedQuery !== query;

	// The tab keeps the whole count while a search narrows the list (DAT-2).
	useEffect(() => {
		if (board.data && debouncedQuery === '') setCount('leaderboard', board.data.length);
	}, [board.data, debouncedQuery, setCount]);

	const toggleSort = (key: LeaderboardSort) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection(key === 'name' ? 'asc' : 'desc');
		}
	};
	const open = (model: RankedModel) => {
		setSelected(model);
		setShowModal(true);
	};

	const failed = board.isError || models.isError;
	const loading = board.isPending || models.isPending;

	return (
		<>
			<LeaderboardModal open={showModal} onOpenChange={setShowModal} model={selected} />

			<div className="flex flex-col gap-2">
				{(query !== '' || ranked.length > 0) && (
					<ListSearchBar value={query} onChange={setQuery} placeholder="Search models" />
				)}

				{failed ? (
					<LoadFailed
						what="the leaderboard"
						error={board.error ?? models.error}
						onRetry={() => {
							board.refetch();
							models.refetch();
						}}
						retrying={board.isFetching || models.isFetching}
					/>
				) : loading || (ranked.length === 0 && searching) ? (
					<TableSkeleton label="the leaderboard" />
				) : ranked.length === 0 ? (
					<ListEmptyState
						title="No ratings yet"
						description={
							ratingOn
								? 'Rate replies with the thumbs under a message to rank your models.'
								: 'Rate replies with the thumbs under a message to rank your models. Message rating is off, so replies have no thumbs yet.'
						}
						action={
							!ratingOn && (
								<Button asChild variant="outline" size="sm">
									<Link to={`${routePaths.adminSettings}/general`}>Turn on message rating</Link>
								</Button>
							)
						}
						query={debouncedQuery}
						onClear={() => setQuery('')}
					/>
				) : (
					<Table
						aria-label="Leaderboard"
						aria-busy={searching || undefined}
						className="text-dense table-fixed text-left"
					>
						<thead>
							<tr className="border-b">
								<th scope="col" className="text-foreground-muted w-14 px-2 py-1.5 font-normal">
									Rank
								</th>
								<TableSortHead
									label="Model"
									active={orderBy === 'name'}
									direction={direction}
									onSort={() => toggleSort('name')}
									className="h-auto py-1 font-normal"
									buttonClassName="text-foreground-muted"
								/>
								{FIGURES.map((col) => (
									<TableSortHead
										key={col.key}
										label={col.label}
										active={orderBy === col.key}
										direction={direction}
										onSort={() => toggleSort(col.key)}
										className={cn('hidden h-auto py-1 text-right font-normal sm:table-cell', col.className)}
										buttonClassName="text-foreground-muted ms-auto"
									/>
								))}
							</tr>
						</thead>
						<tbody>
							{sorted.map((model) => (
								<TableRow key={model.id} className="last:border-0" onOpen={() => open(model)}>
									<td className="text-foreground-muted px-2 py-1.5 tabular-nums">{ranks.get(model.id)}</td>
									<td className="py-1.5">
										<div className="flex min-w-0 items-center gap-2">
											<ProfileAvatar
												src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
												name={model.name}
												size="sm"
											/>
											<div className="flex min-w-0 flex-1 flex-col items-start">
												<Button
													variant="ghost"
													size="sm"
													type="button"
													title={model.name === model.id ? model.id : `${model.name} (${model.id})`}
													className="text-foreground -mx-2.5 max-w-full shrink justify-start"
													onClick={() => open(model)}
												>
													<span className="truncate">{model.name}</span>
												</Button>
												{/* LAY-4: a phone keeps the figures on a second line. */}
												<span className="text-foreground-muted text-caption tabular-nums sm:hidden">
													Elo {figure(model.rating)} · {figure(model.stats.won)}{' '}
													{model.stats.won === 1 ? 'win' : 'wins'} · {figure(model.stats.lost)}{' '}
													{model.stats.lost === 1 ? 'loss' : 'losses'}
												</span>
											</div>
										</div>
									</td>
									<td className="text-foreground hidden px-2 py-1.5 text-right tabular-nums sm:table-cell">
										{figure(model.rating)}
									</td>
									<td className="text-foreground hidden px-2 py-1.5 text-right tabular-nums sm:table-cell">
										<Record value={model.stats.won} count={model.stats.count} />
									</td>
									<td className="text-foreground hidden px-2 py-1.5 text-right tabular-nums sm:table-cell">
										<Record value={model.stats.lost} count={model.stats.count} />
									</td>
								</TableRow>
							))}
						</tbody>
					</Table>
				)}

				{ranked.length > 0 && (
					<p className="text-foreground-muted text-caption">
						Elo rises when a model's reply is rated up or preferred in an arena comparison, and falls when it loses.
					</p>
				)}
			</div>
		</>
	);
}
