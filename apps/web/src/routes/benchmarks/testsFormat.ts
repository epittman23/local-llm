import type { DatasetStatus, WindowIncrement } from '@/lib/apis/benchmarks';

/**
 * Pure formatting rules for the Tests page, kept apart from the component so
 * they can be unit-tested.
 */

export type DatasetEvent = {
	benchmark: string;
	n_items: number;
	revision: string;
	fetched: boolean;
	/** Committed to the repository: Fetch downloaded nothing and only verified it. */
	vendored?: boolean;
};

/** The status line a Fetch job's `dataset` event becomes. */
export const datasetEventText = (d: DatasetEvent): string => {
	const what = d.vendored ? 'in the repository, verified' : d.fetched ? 'fetched' : 'already downloaded';
	return `${d.benchmark}: ${what}, ${d.n_items} items, revision ${d.revision}`;
};

/** The Datasets panel's calibration cell: gradeable items, or why the calibration no longer applies. */
export const calibrationText = (d: DatasetStatus): string => {
	// A vendored file that fails its hash arrives unfetched, with the reason here.
	if (d.calibration_stale) return d.calibration_stale;
	if (!d.fetched) return '–';
	return `${(d.n_checked ?? 0) - (d.n_ungradeable ?? 0)}/${d.n_checked} gradeable`;
};

// A fetch's running counts: one line per second of download, and one per 25
// problems decoded.
const PROGRESS_TICK = /^(\S+): (\S+: \d+ of \d+ MiB|\S+: decoded \d+ of \d+ problems)$/;

/**
 * Add a job note, except that a fetch's running count replaces the count
 * before it, so fetching every increment leaves one moving line, not hundreds.
 */
export const appendNote = (notes: string[], line: string): string[] => {
	const tick = PROGRESS_TICK.exec(line);
	const last = notes.at(-1);
	const lastTick = last === undefined ? null : PROGRESS_TICK.exec(last);
	if (tick && lastTick && lastTick[1] === tick[1]) return [...notes.slice(0, -1), line];
	return [...notes, line];
};

/** A byte count the way the fetch progress reports it. */
export const formatBytes = (bytes: number): string =>
	bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GiB` : `${Math.round(bytes / 2 ** 20)} MiB`;

/** One increment's checkbox label: its problems, their dates, its download size, and whether it is on disk. */
export const incrementLabel = (inc: WindowIncrement): string =>
	`${inc.name}: ${inc.items} problems, ${inc.first} to ${inc.last}, ${formatBytes(inc.bytes)}${inc.fetched ? ' (fetched)' : ''}`;

/** Why a release-date window cannot be sent, or '' when it can. Dates are YYYY-MM-DD, so they compare as text. */
export const windowError = (min: string, max: string): string => {
	if (!min && max) return 'A window needs its first date.';
	if (min && max && max < min) return 'The window ends before it starts.';
	return '';
};

/**
 * The increments a window touches that are not fetched, the rule the server
 * applies: every increment whose dates overlap the window, since their ranges
 * overlap and the pool must not depend on which happen to be on disk.
 */
export const missingIncrements = (increments: WindowIncrement[], min: string, max: string): string[] =>
	min
		? increments.filter((inc) => !inc.fetched && inc.last >= min && (!max || inc.first <= max)).map((inc) => inc.name)
		: [];

/** The tiers in the order they cost, cheapest first: smoke, standard, full, then any others by name (#918). */
const TIER_ORDER = ['smoke', 'standard', 'full'];
export const orderTiers = (tiers: string[]): string[] =>
	[...tiers].sort((a, b) => {
		const ia = TIER_ORDER.indexOf(a);
		const ib = TIER_ORDER.indexOf(b);
		return (ia === -1 ? TIER_ORDER.length : ia) - (ib === -1 ? TIER_ORDER.length : ib) || a.localeCompare(b);
	});

/** The tier the page opens on: smoke, the fast one, so one click on Run never starts a many-hours run (B-D1). */
export const defaultTier = (tiers: string[]): string =>
	tiers.includes('smoke') ? 'smoke' : (orderTiers(tiers)[0] ?? '');

/** How big each tier is, from docs/guides/benchmarks.md "Tiers"; a tier not listed shows its name alone. */
export const TIER_SIZE: Record<string, string> = {
	smoke: '8 items per benchmark',
	standard: '100 items per benchmark',
	full: 'every item, many hours'
};

/** A duration as a person reads it: "45 s", "3 min 20 s", "1 h 5 min". */
export const formatDuration = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
	return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
};

type Graded = { outcome: string; i: number };

/** Where a run stands: items done of the total, passes, skips, the pass rate, and the time left at the mean pace so far. */
export const runProgress = (items: Graded[], total: number, elapsedMs: number) => {
	const done = items.length ? Math.max(...items.map((it) => it.i)) : 0;
	const passed = items.filter((it) => it.outcome === 'pass').length;
	const skipped = items.filter((it) => it.outcome === 'skipped').length;
	const attempted = items.length - skipped;
	const rate = attempted ? passed / attempted : null;
	const left = total > done && done > 0 ? (elapsedMs / done) * (total - done) : null;
	return { done, total, passed, skipped, attempted, rate, leftMs: left };
};

/**
 * A pass rate, said one way wherever it is shown: passes of the items
 * attempted, skipped items left out of both ("7 of 11 passed (64%)").
 * The server's `attempted` already leaves skipped items out.
 */
export const passText = (passed: number, attempted: number, word = 'passed'): string =>
	`${passed} of ${attempted} ${word}${attempted ? ` (${Math.round((passed / attempted) * 100)}%)` : ''}`;

/** The fetch button says what it will download: the ticked increments and their size (#1048). */
export const fetchLabel = (increments: WindowIncrement[], chosen: string[]): string => {
	const picked = increments.filter((inc) => chosen.includes(inc.name));
	if (!picked.length) return 'Fetch datasets';
	const bytes = picked.reduce((sum, inc) => sum + inc.bytes, 0);
	return `Fetch ${picked.length} ${picked.length === 1 ? 'increment' : 'increments'} · ${formatBytes(bytes)}`;
};
