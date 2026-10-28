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
	if (!d.fetched) return '-';
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
