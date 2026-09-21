import { describe, expect, it } from 'vitest';
import { type DailyPoint, type ModelStat, chartModels, chartPeriod, dateRange, isCustomIncomplete, parsePeriod, sharePercent, sortModels, sortUsers } from './analytics';

const NOW = 1_800_000_000;
const DAY = 86400;

describe('dateRange', () => {
	it('is a trailing window ending now for the fixed periods', () => {
		expect(dateRange('24h', '', '', NOW)).toEqual({ start: NOW - DAY, end: NOW });
		expect(dateRange('7d', '', '', NOW)).toEqual({ start: NOW - 7 * DAY, end: NOW });
		expect(dateRange('90d', '', '', NOW)).toEqual({ start: NOW - 90 * DAY, end: NOW });
	});
	it('is unbounded for all time (and any unknown period)', () => {
		expect(dateRange('all', '', '', NOW)).toEqual({ start: null, end: null });
		expect(dateRange('nonsense', '', '', NOW)).toEqual({ start: null, end: null });
	});
	it('makes a custom end date inclusive of the whole day', () => {
		const r = dateRange('custom', '2026-09-01', '2026-09-03', NOW);
		expect(r.start).toBe(Date.UTC(2026, 8, 1) / 1000);
		expect(r.end).toBe(Date.UTC(2026, 8, 3) / 1000 + DAY - 1);
	});
	it('leaves an unset custom end open', () => {
		expect(dateRange('custom', '2026-09-01', '', NOW).end).toBeNull();
	});
});

describe('isCustomIncomplete', () => {
	it('only cares in custom mode', () => {
		expect(isCustomIncomplete('custom', '2026-01-01', '')).toBe(true);
		expect(isCustomIncomplete('custom', '2026-01-01', '2026-01-02')).toBe(false);
		expect(isCustomIncomplete('7d', '', '')).toBe(false);
	});
});

describe('sortModels', () => {
	const models: ModelStat[] = [
		{ model_id: 'a', name: 'Alpha', count: 5, unique_users: 1, unique_chats: 9 },
		{ model_id: 'b', name: 'Beta', count: 20, unique_users: 4, unique_chats: 2 },
		{ model_id: 'c', name: 'Cee', count: 10 }
	];
	const tokens = { a: { input_tokens: 0, output_tokens: 0, total_tokens: 300 }, b: { input_tokens: 0, output_tokens: 0, total_tokens: 100 } };
	it('sorts each column, treating missing counts as zero', () => {
		const ids = (by: Parameters<typeof sortModels>[2], dir: 'asc' | 'desc') => sortModels(models, tokens, by, dir).map((m) => m.model_id);
		expect(ids('count', 'desc')).toEqual(['b', 'c', 'a']);
		expect(ids('users', 'desc')).toEqual(['b', 'a', 'c']);
		expect(ids('chats', 'asc')).toEqual(['c', 'b', 'a']);
		expect(ids('tokens', 'desc')).toEqual(['a', 'b', 'c']);
		expect(ids('name', 'asc')).toEqual(['a', 'b', 'c']);
	});
	it('orders % exactly as count', () => {
		expect(sortModels(models, tokens, 'percentage', 'desc').map((m) => m.model_id)).toEqual(['b', 'c', 'a']);
	});
});

describe('sortUsers', () => {
	const users = [
		{ user_id: 'u1', name: 'Zed', count: 1, total_tokens: 50 },
		{ user_id: 'u2', count: 9 },
		{ user_id: 'a3', name: '', count: 5, total_tokens: 70 }
	];
	it('sorts by name (falling back to the id), messages and tokens', () => {
		expect(sortUsers(users, 'name', 'asc').map((u) => u.user_id)).toEqual(['a3', 'u2', 'u1']);
		expect(sortUsers(users, 'count', 'desc').map((u) => u.user_id)).toEqual(['u2', 'a3', 'u1']);
		expect(sortUsers(users, 'tokens', 'desc').map((u) => u.user_id)).toEqual(['a3', 'u1', 'u2']);
	});
});

describe('small helpers', () => {
	it('formats a share with one decimal and survives a zero total', () => {
		expect(sharePercent(1, 3)).toBe('33.3');
		expect(sharePercent(5, 0)).toBe('0');
	});
	it('picks the chart models in first-seen order, capped at eight', () => {
		const daily: DailyPoint[] = [{ date: 'd1', models: { a: 1, b: 2 } }, { date: 'd2', models: { b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1, j: 1 } }];
		expect(chartModels(daily)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
	});
	it('maps periods to chart label styles, defaulting to week', () => {
		expect([chartPeriod('24h'), chartPeriod('90d'), chartPeriod('custom')]).toEqual(['hour', 'year', 'week']);
	});
	it('falls back to 7d for a bad stored period', () => {
		expect([parsePeriod('30d'), parsePeriod('bogus'), parsePeriod(null)]).toEqual(['30d', '7d', '7d']);
	});
});
