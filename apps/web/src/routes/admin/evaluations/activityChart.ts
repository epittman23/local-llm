export type ActivityDay = { date: string; won: number; lost: number };
export type ActivityBucket = { label: string; won: number; lost: number };

const monthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The bars for ModelActivityChart. Daily data is one bar per day; the 1Y / All
 * ranges (`weekly`) sum days into Monday-started weeks, but only when there is
 * more than a week of data, as in the Svelte chart.
 *
 * Days are `YYYY-MM-DD` and are read as UTC throughout. The Svelte version
 * parses them as UTC but takes the weekday in local time, so west of UTC the
 * week boundary lands a day early and labels can name the previous day.
 */
export function activityBuckets(history: ActivityDay[], weekly: boolean): ActivityBucket[] {
	if (!weekly || history.length <= 7) {
		return history.map((h) => ({ label: monthDay(new Date(h.date)), won: h.won, lost: h.lost }));
	}
	const weeks = new Map<string, ActivityBucket & { start: string }>();
	for (const h of history) {
		const date = new Date(h.date);
		const day = date.getUTCDay();
		const monday = new Date(date);
		monday.setUTCDate(date.getUTCDate() - day + (day === 0 ? -6 : 1));
		const start = monday.toISOString().split('T')[0];
		const week = weeks.get(start) ?? { start, label: monthDay(monday), won: 0, lost: 0 };
		week.won += h.won;
		week.lost += h.lost;
		weeks.set(start, week);
	}
	return [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** True when there is nothing to draw (no rows, or every row is zero). */
export const isEmptyActivity = (history: ActivityDay[]) => history.length === 0 || history.every((h) => h.won === 0 && h.lost === 0);
