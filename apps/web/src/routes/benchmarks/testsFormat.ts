import type { DatasetStatus } from '@/lib/apis/benchmarks';

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
