import { describe, expect, it } from 'vitest';
import { type LeaderboardEntry, buildRankedModels, leaderboardCount, percentOf, rankById, sortRanked } from './leaderboard';

const models = [
	{ id: 'a', name: 'Alpha' },
	{ id: 'b', name: 'Beta' },
	{ id: 'arena', name: 'Arena', owned_by: 'arena' },
	{ id: 'hidden', name: 'Hidden', info: { meta: { hidden: true } } },
	{ id: 'c' }
];
const entries: LeaderboardEntry[] = [
	{ model_id: 'a', rating: 1010, won: 3, lost: 1, top_tags: [{ tag: 'code', count: 2 }] },
	{ model_id: 'b', rating: 1200, won: 5, lost: 5 },
	{ model_id: 'gone', rating: 1100, won: 1, lost: 0 }
];

describe('buildRankedModels', () => {
	const ranked = buildRankedModels(models, entries);
	it('lists active models and gone-but-rated ones, skipping arena and hidden', () => {
		expect(ranked.map((m) => m.id)).toEqual(['b', 'gone', 'a', 'c']);
	});
	it('marks the unrated model with dashes and falls back to its id for a name', () => {
		const c = ranked.find((m) => m.id === 'c')!;
		expect(c).toMatchObject({ rating: '-', name: 'c', stats: { count: 0, won: '-', lost: '-' } });
	});
	it('carries win/loss counts and tags', () => {
		expect(ranked.find((m) => m.id === 'a')).toMatchObject({ stats: { count: 4, won: '3', lost: '1' }, top_tags: [{ tag: 'code', count: 2 }] });
	});
	it('names an uninstalled model by its id', () => {
		expect(ranked.find((m) => m.id === 'gone')?.name).toBe('gone');
	});
});

describe('leaderboardCount', () => {
	it('counts active models plus evaluated models that are not installed', () => {
		expect(leaderboardCount(models, entries)).toBe(4);
	});
});

describe('rankById', () => {
	it('ranks by rating and leaves the unrated out, whatever the display sort', () => {
		const ranks = rankById(buildRankedModels(models, entries));
		expect([ranks.get('b'), ranks.get('gone'), ranks.get('a'), ranks.get('c')]).toEqual([1, 2, 3, undefined]);
	});
});

describe('sortRanked', () => {
	const ranked = buildRankedModels(models, entries);
	it('sorts by rating with unrated last when descending', () => {
		expect(sortRanked(ranked, 'rating', 'desc').map((m) => m.id)).toEqual(['b', 'gone', 'a', 'c']);
		expect(sortRanked(ranked, 'rating', 'asc').map((m) => m.id)).toEqual(['c', 'a', 'gone', 'b']);
	});
	it('sorts by name, and by won treating dashes as lowest', () => {
		expect(sortRanked(ranked, 'name', 'asc').map((m) => m.name)).toEqual(['Alpha', 'Beta', 'c', 'gone']);
		expect(sortRanked(ranked, 'won', 'desc').map((m) => m.id)).toEqual(['b', 'a', 'gone', 'c']);
	});
	it('does not reorder the input', () => {
		const before = ranked.map((m) => m.id);
		sortRanked(ranked, 'name', 'asc');
		expect(ranked.map((m) => m.id)).toEqual(before);
	});
});

describe('percentOf', () => {
	it('formats one decimal and survives a zero total', () => {
		expect(percentOf('3', 4)).toBe('75.0');
		expect(percentOf('0', 0)).toBe('0.0');
	});
});
