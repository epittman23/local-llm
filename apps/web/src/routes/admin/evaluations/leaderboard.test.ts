import { describe, expect, it } from 'vitest';
import {
	buildRankedModels,
	type LeaderboardEntry,
	leaderboardCount,
	percentOf,
	rankById,
	sortRanked
} from './leaderboard';

const models = [
	{ id: 'a', name: 'Alpha' },
	{ id: 'b', name: 'Beta' },
	{ id: 'hidden', name: 'Hidden', info: { meta: { hidden: true } } },
	{ id: 'c' }
];
const entries: LeaderboardEntry[] = [
	{ model_id: 'a', rating: 1010, won: 3, lost: 1, top_tags: [{ tag: 'code', count: 2 }] },
	{ model_id: 'b', rating: 1200, won: 5, lost: 5 },
	{ model_id: 'gone', rating: 1100, won: 1, lost: 0 }
];

describe('buildRankedModels (#1027)', () => {
	const ranked = buildRankedModels(models, entries);
	it('lists only the rated models, by rating', () => {
		expect(ranked.map((m) => m.id)).toEqual(['b', 'gone', 'a']);
	});
	it('leaves out an installed model nobody has rated', () => {
		expect(ranked.find((m) => m.id === 'c')).toBeUndefined();
		expect(buildRankedModels(models, [])).toEqual([]);
	});
	it('carries win/loss counts and tags', () => {
		expect(ranked.find((m) => m.id === 'a')).toMatchObject({
			name: 'Alpha',
			stats: { count: 4, won: 3, lost: 1 },
			top_tags: [{ tag: 'code', count: 2 }]
		});
	});
	it('names an uninstalled model by its id', () => {
		expect(ranked.find((m) => m.id === 'gone')?.name).toBe('gone');
	});
});

describe('leaderboardCount', () => {
	it('counts the rated models', () => {
		expect(leaderboardCount(entries)).toBe(3);
	});
});

describe('rankById', () => {
	it('ranks by rating, whatever order the rows come in', () => {
		const ranks = rankById(sortRanked(buildRankedModels(models, entries), 'name', 'asc'));
		expect([ranks.get('b'), ranks.get('gone'), ranks.get('a')]).toEqual([1, 2, 3]);
	});
});

describe('sortRanked', () => {
	const ranked = buildRankedModels(models, entries);
	it('sorts by rating either way', () => {
		expect(sortRanked(ranked, 'rating', 'desc').map((m) => m.id)).toEqual(['b', 'gone', 'a']);
		expect(sortRanked(ranked, 'rating', 'asc').map((m) => m.id)).toEqual(['a', 'gone', 'b']);
	});
	it('sorts by name, and by wins or losses', () => {
		expect(sortRanked(ranked, 'name', 'asc').map((m) => m.name)).toEqual(['Alpha', 'Beta', 'gone']);
		expect(sortRanked(ranked, 'won', 'desc').map((m) => m.id)).toEqual(['b', 'a', 'gone']);
		expect(sortRanked(ranked, 'lost', 'asc').map((m) => m.id)).toEqual(['gone', 'a', 'b']);
	});
	it('does not reorder the input', () => {
		const before = ranked.map((m) => m.id);
		sortRanked(ranked, 'name', 'asc');
		expect(ranked.map((m) => m.id)).toEqual(before);
	});
});

describe('percentOf', () => {
	it('rounds to a whole percentage and survives a zero total', () => {
		expect(percentOf(2, 3)).toBe(67);
		expect(percentOf(0, 0)).toBe(0);
	});
});
