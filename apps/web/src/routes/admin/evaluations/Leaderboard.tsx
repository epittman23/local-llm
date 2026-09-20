import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { getModels } from '@/lib/apis';
import { getLeaderboard } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { LeaderboardModal } from './LeaderboardModal';
import {
	type LeaderboardEntry,
	type LeaderboardSort,
	type ModelInfo,
	type RankedModel,
	buildRankedModels,
	percentOf,
	rankById,
	sortRanked
} from './leaderboard';

const COLUMNS: { key: LeaderboardSort; label: string; className: string }[] = [
	{ key: 'rating', label: 'RK', className: 'w-3' },
	{ key: 'name', label: 'Model', className: '' },
	{ key: 'rating', label: 'Rating', className: 'text-right w-fit' },
	{ key: 'won', label: 'Won', className: 'text-right w-5' },
	{ key: 'lost', label: 'Lost', className: 'text-right w-5' }
];

/**
 * Ports Evaluations/Leaderboard.svelte: every model with its Elo rating and
 * won/lost record (hover a row to see the percentages), searchable (500ms
 * debounce, server-side) and sortable. Click a row for its activity chart.
 *
 * The model list comes from `/api/models` through react-query (the Svelte app
 * reads its global `models` store, which the chat surface will own in Phase 10).
 */
export function Leaderboard() {
	const token = useAuthStore((s) => s.token) ?? '';
	const setCount = useAdminStore((s) => s.setCount);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 500);
	const [orderBy, setOrderBy] = useState<LeaderboardSort>('rating');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [selected, setSelected] = useState<RankedModel | null>(null);
	const [showModal, setShowModal] = useState(false);

	const models = useQuery({ queryKey: ['models-all'], queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[] });
	const board = useQuery({
		queryKey: ['admin', 'leaderboard', debouncedQuery],
		queryFn: async () => ((await getLeaderboard(token, debouncedQuery))?.entries ?? []) as LeaderboardEntry[],
		enabled: !models.isPending
	});

	const ranked = useMemo(() => buildRankedModels(models.data ?? [], board.data ?? []), [models.data, board.data]);
	const ranks = useMemo(() => rankById(ranked), [ranked]);
	const sorted = useMemo(() => sortRanked(ranked, orderBy, direction), [ranked, orderBy, direction]);
	const loading = models.isPending || board.isPending || board.isFetching || debouncedQuery !== query;

	useEffect(() => {
		if (board.data && models.data) setCount('leaderboard', ranked.length);
	}, [board.data, models.data, ranked.length, setCount]);

	const toggleSort = (key: LeaderboardSort) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection(key === 'name' ? 'asc' : 'desc');
		}
	};

	return (
		<>
			<LeaderboardModal open={showModal} onOpenChange={setShowModal} model={selected} />

			<div>
				<div className="bg-background sticky top-0 z-10">
					<div className="flex h-8 w-full flex-1 items-center gap-2">
						<div className="flex min-w-0 flex-1 items-center">
							<Search className="mr-3 ml-1 size-3.5" />
							<input
								className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								aria-label="Search"
								placeholder="Search"
							/>
							{query && (
								<button type="button" className="hover:bg-muted rounded-full p-0.5 transition" aria-label="Clear search" onClick={() => setQuery('')}>
									<X className="size-3" strokeWidth={2} />
								</button>
							)}
						</div>
					</div>
				</div>

				<div className="relative max-w-full min-h-[6.25rem] overflow-x-auto rounded-sm whitespace-nowrap">
					{loading && (
						<div className="bg-background/50 absolute inset-0 z-10 flex items-center justify-center">
							<Spinner />
						</div>
					)}

					{!ranked.length && !loading ? (
						<div className="text-muted-foreground py-1 text-center text-xs">No models found</div>
					) : (
						ranked.length > 0 && (
							<table className={cn('text-muted-foreground w-full text-left text-sm', loading && 'opacity-20')}>
								<thead className="text-foreground bg-transparent text-xs uppercase">
									<tr className="border-b">
										{COLUMNS.map((col, i) => (
											<th key={i} scope="col" className={cn('cursor-pointer px-2.5 py-2 font-normal select-none', col.className)} onClick={() => toggleSort(col.key)}>
												<div className={cn('flex items-center gap-1.5', col.className.includes('right') && 'justify-end')}>
													{col.label}
													{orderBy === col.key ? (
														direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" />
													) : (
														<ChevronUp className="invisible size-2" />
													)}
												</div>
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{sorted.map((model) => (
										<tr
											key={model.id}
											className="group hover:bg-muted/50 cursor-pointer text-xs transition"
											onClick={() => {
												setSelected(model);
												setShowModal(true);
											}}
										>
											<td className="text-foreground px-3 py-1.5 font-normal">{ranks.get(model.id) ?? '-'}</td>
											<td className="px-3 py-1.5">
												<div className="flex items-center gap-2">
													<img
														src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
														alt={model.name}
														className="size-5 shrink-0 rounded-full object-cover"
														onError={(e) => {
															// LICENSE covers this Open WebUI fallback logo.
															// Do not alter, remove, obscure, or replace it except as LICENSE permits:
															// https://docs.openwebui.com/license.
															e.currentTarget.src = '/favicon.png';
														}}
													/>
													<Tip content={`${model.name} (${model.id})`} side="top">
														<span className="text-foreground line-clamp-1 font-normal">{model.name}</span>
													</Tip>
												</div>
											</td>
											<td className="text-foreground px-3 py-1.5 text-right font-normal">{model.rating}</td>
											<td className="w-10 px-3 py-1.5 text-right font-normal text-green-500">
												{model.stats.won === '-' ? (
													'-'
												) : (
													<>
														<span className="hidden group-hover:inline">{percentOf(model.stats.won, model.stats.count)}%</span>
														<span className="group-hover:hidden">{model.stats.won}</span>
													</>
												)}
											</td>
											<td className="w-10 px-3 py-1.5 text-right font-normal text-red-500">
												{model.stats.lost === '-' ? (
													'-'
												) : (
													<>
														<span className="hidden group-hover:inline">{percentOf(model.stats.lost, model.stats.count)}%</span>
														<span className="group-hover:hidden">{model.stats.lost}</span>
													</>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)
					)}
				</div>
			</div>

			<div className="text-muted-foreground mt-1.5 flex w-full justify-end text-xs">
				<div className="line-clamp-1 text-right">ⓘ The evaluation leaderboard is based on the Elo rating system and is updated in real-time.</div>
			</div>
		</>
	);
}
