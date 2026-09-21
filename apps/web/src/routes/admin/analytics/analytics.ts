export type Period = '24h' | '7d' | '30d' | '90d' | 'all' | 'custom';

export const PERIODS: { value: Period; label: string }[] = [
	{ value: '24h', label: 'Last 24 hours' },
	{ value: '7d', label: 'Last 7 days' },
	{ value: '30d', label: 'Last 30 days' },
	{ value: '90d', label: 'Last 90 days' },
	{ value: 'all', label: 'All time' },
	{ value: 'custom', label: 'Custom range' }
];

const DAY = 86400;

/**
 * The unix-second window for a period. `all` is unbounded (both null). A custom
 * range takes `YYYY-MM-DD` strings; its end date is inclusive, so it runs to the
 * last second of that day. (Dates parse as UTC, as `new Date('2026-09-20')`
 * does, which is what the Svelte dashboard sends.)
 */
export function dateRange(period: string, customStart: string, customEnd: string, nowSeconds = Math.floor(Date.now() / 1000)): { start: number | null; end: number | null } {
	switch (period) {
		case '24h':
			return { start: nowSeconds - DAY, end: nowSeconds };
		case '7d':
			return { start: nowSeconds - 7 * DAY, end: nowSeconds };
		case '30d':
			return { start: nowSeconds - 30 * DAY, end: nowSeconds };
		case '90d':
			return { start: nowSeconds - 90 * DAY, end: nowSeconds };
		case 'custom':
			return {
				start: customStart ? Math.floor(new Date(customStart).getTime() / 1000) : null,
				end: customEnd ? Math.floor(new Date(customEnd).getTime() / 1000) + DAY - 1 : null
			};
		default:
			return { start: null, end: null };
	}
}

/** The custom range needs both ends before it is worth asking the server. */
export const isCustomIncomplete = (period: string, customStart: string, customEnd: string) => period === 'custom' && !(customStart && customEnd);

export type ModelStat = { model_id: string; count: number; unique_users?: number; unique_chats?: number; name: string };
export type UserStat = { user_id: string; name?: string; email?: string; count: number; total_tokens?: number };
export type TokenStats = Record<string, { input_tokens: number; output_tokens: number; total_tokens: number }>;

export type ModelSort = 'name' | 'count' | 'users' | 'chats' | 'tokens' | 'percentage';
export type UserSort = 'name' | 'count' | 'tokens';

/**
 * Sorts a copy of the model table. `percentage` is the message count over a
 * constant total, so it orders exactly as `count` does (the Svelte header has
 * a "%" sort with no branch of its own and falls through to count).
 */
export function sortModels(models: ModelStat[], tokens: TokenStats, orderBy: ModelSort, direction: 'asc' | 'desc'): ModelStat[] {
	const sign = direction === 'asc' ? 1 : -1;
	const value = (m: ModelStat) =>
		orderBy === 'tokens' ? (tokens[m.model_id]?.total_tokens ?? 0) : orderBy === 'users' ? (m.unique_users ?? 0) : orderBy === 'chats' ? (m.unique_chats ?? 0) : m.count;
	return [...models].sort((a, b) => (orderBy === 'name' ? sign * a.name.localeCompare(b.name) : sign * (value(a) - value(b))));
}

/** Sorts a copy of the user table; a user with no name sorts under their id. */
export function sortUsers(users: UserStat[], orderBy: UserSort, direction: 'asc' | 'desc'): UserStat[] {
	const sign = direction === 'asc' ? 1 : -1;
	return [...users].sort((a, b) => {
		if (orderBy === 'name') return sign * (a.name || a.user_id).localeCompare(b.name || b.user_id);
		if (orderBy === 'tokens') return sign * ((a.total_tokens ?? 0) - (b.total_tokens ?? 0));
		return sign * (a.count - b.count);
	});
}

/** A share of the total, one decimal (`0` when there is no total). */
export const sharePercent = (count: number, total: number) => (total > 0 ? ((count / total) * 100).toFixed(1) : '0');

export type DailyPoint = { date: string; models: Record<string, number> };

export const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

/** The first eight models to appear in the series, in order of first appearance -- the ones the chart draws. */
export const chartModels = (daily: DailyPoint[]) => [...new Set(daily.flatMap((d) => Object.keys(d.models || {})))].slice(0, CHART_COLORS.length);

/** The x-axis label style ChartLine keys off. */
export const chartPeriod = (period: string): 'hour' | 'week' | 'month' | 'year' | 'all' =>
	({ '24h': 'hour', '7d': 'week', '30d': 'month', '90d': 'year', all: 'all' } as Record<string, 'hour' | 'week' | 'month' | 'year' | 'all'>)[period] ?? 'week';

/** Reads a persisted period, falling back to 7 days for anything unrecognised. */
export const parsePeriod = (raw: string | null | undefined): Period => (PERIODS.some((p) => p.value === raw) ? (raw as Period) : '7d');
