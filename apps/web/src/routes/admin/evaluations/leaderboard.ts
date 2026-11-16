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
	rating: number;
	stats: { count: number; won: number; lost: number };
	top_tags: { tag: string; count: number }[];
};

/**
 * The leaderboard's rows: only models someone has rated (#1027), by rating.
 * An installed model is named as the picker names it; one that has ratings
 * but is no longer installed is named by its id. Arena aliases and hidden
 * models keep their rows: their ratings are history.
 */
export function buildRankedModels(models: ModelInfo[], entries: LeaderboardEntry[]): RankedModel[] {
	const known = new Map(models.map((m) => [m.id, m]));
	return entries
		.map((e) => ({
			id: e.model_id,
			name: known.get(e.model_id)?.name ?? e.model_id,
			rating: e.rating,
			stats: { count: e.won + e.lost, won: e.won, lost: e.lost },
			top_tags: e.top_tags ?? []
		}))
		.sort((a, b) => b.rating - a.rating);
}

/** The tab count: the models with ratings. */
export function leaderboardCount(entries: LeaderboardEntry[]): number {
	return entries.length;
}

/**
 * Rank (1-based) of each model by rating, ties broken by order. A rank is a
 * property of the rating, so sorting the table by name does not renumber it.
 */
export function rankById(ranked: RankedModel[]): Map<string, number> {
	return new Map([...ranked].sort((a, b) => b.rating - a.rating).map((m, i) => [m.id, i + 1]));
}

export type LeaderboardSort = 'rating' | 'name' | 'won' | 'lost';

/** Sorts a copy. */
export function sortRanked(models: RankedModel[], orderBy: LeaderboardSort, direction: 'asc' | 'desc'): RankedModel[] {
	const sign = direction === 'asc' ? 1 : -1;
	return [...models].sort((a, b) => {
		if (orderBy === 'name') return sign * a.name.localeCompare(b.name);
		const av = orderBy === 'rating' ? a.rating : a.stats[orderBy];
		const bv = orderBy === 'rating' ? b.rating : b.stats[orderBy];
		return sign * (av - bv);
	});
}

/** Won/lost as a whole percentage of decided games, shown beside the count. */
export const percentOf = (value: number, count: number) => (count > 0 ? Math.round((value / count) * 100) : 0);

/** A figure in full, thousands separated (DAT-2): "1,032", never the tab count's compact "1k". */
export const figure = (n: number) => n.toLocaleString('en-US');
