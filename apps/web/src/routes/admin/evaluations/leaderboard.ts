export type LeaderboardEntry = {
	model_id: string;
	rating: number;
	won: number;
	lost: number;
	top_tags?: { tag: string; count: number }[];
};

/** The bits of a chat model the leaderboard reads. */
export type ModelInfo = {
	id: string;
	name?: string;
	owned_by?: string;
	info?: { meta?: { hidden?: boolean } };
};

export type RankedModel = {
	id: string;
	name: string;
	/** '-' for a model nobody has rated yet. */
	rating: number | '-';
	stats: { count: number; won: string; lost: string };
	top_tags: { tag: string; count: number }[];
};

/** A model people can pick today: not an arena alias and not hidden. */
const isActive = (m: ModelInfo) => m?.owned_by !== 'arena' && !m?.info?.meta?.hidden;

/**
 * The leaderboard's rows: every active model (rated or not -- unrated ones show
 * "-"), followed by models that have feedback but are no longer installed, all
 * ordered by rating with unrated last. Ports Leaderboard.svelte's
 * `loadLeaderboard`.
 */
export function buildRankedModels(models: ModelInfo[], entries: LeaderboardEntry[]): RankedModel[] {
	const stats = new Map(entries.map((e) => [e.model_id, e]));
	const known = new Map(models.map((m) => [m.id, m]));

	const active: RankedModel[] = models.filter(isActive).map((model) => {
		const s = stats.get(model.id);
		return {
			id: model.id,
			name: model.name ?? model.id,
			rating: s?.rating ?? '-',
			stats: { count: s ? s.won + s.lost : 0, won: s?.won?.toString() ?? '-', lost: s?.lost?.toString() ?? '-' },
			top_tags: s?.top_tags ?? []
		};
	});
	const evaluated: RankedModel[] = entries
		.filter((e) => !known.has(e.model_id))
		.map((e) => ({
			id: e.model_id,
			name: e.model_id,
			rating: e.rating,
			stats: { count: e.won + e.lost, won: e.won.toString(), lost: e.lost.toString() },
			top_tags: e.top_tags ?? []
		}));

	return [...active, ...evaluated].sort((a, b) => {
		if (a.rating === '-') return 1;
		if (b.rating === '-') return -1;
		return b.rating - a.rating;
	});
}

/** The tab count (Evaluations.svelte's `getLeaderboardCount`): active models plus evaluated-but-gone ones. */
export function leaderboardCount(models: ModelInfo[], entries: LeaderboardEntry[]): number {
	const known = new Set(models.map((m) => m.id));
	return models.filter(isActive).length + entries.filter((e) => !known.has(e.model_id)).length;
}

/**
 * Rank (1-based) of each rated model by rating, ties broken by order. The
 * Svelte table prints the row's *position* in whatever sort is active, so
 * sorting by name renumbers "RK" 1..n down the page; a rank is a property of the
 * rating, so it is computed once from the rating order here instead.
 */
export function rankById(ranked: RankedModel[]): Map<string, number> {
	const ranks = new Map<string, number>();
	let next = 1;
	for (const m of ranked) if (m.rating !== '-') ranks.set(m.id, next++);
	return ranks;
}

export type LeaderboardSort = 'rating' | 'name' | 'won' | 'lost';

/** Sorts a copy. Unrated ("-") counts as -Infinity, so it sorts last descending and first ascending. */
export function sortRanked(models: RankedModel[], orderBy: LeaderboardSort, direction: 'asc' | 'desc'): RankedModel[] {
	const value = (m: RankedModel) => {
		if (orderBy === 'name') return m.name ?? m.id ?? '';
		if (orderBy === 'rating') return m.rating === '-' ? -Infinity : m.rating;
		const v = m.stats[orderBy];
		return v === '-' ? -Infinity : Number(v);
	};
	return [...models].sort((a, b) => {
		const av = value(a);
		const bv = value(b);
		if (orderBy === 'name') return direction === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
		return direction === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
	});
}

/** Won/lost as a percentage of decided games, one decimal, for the hover state. */
export const percentOf = (value: string, count: number) => (count > 0 ? ((Number(value) / count) * 100).toFixed(1) : '0.0');
