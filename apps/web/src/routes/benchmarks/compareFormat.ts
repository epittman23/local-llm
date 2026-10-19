import type { CompareBlock, ComparePair, CompareRow } from '@/lib/apis/benchmarks';

/**
 * Pure formatting rules for the Compare page, kept apart from the components
 * so they can be unit-tested. Rates arrive as fractions and intervals as
 * `[lo, hi]` pairs; the page never shows a rate without its counts or its
 * interval.
 */

export const isRateColumn = (col: string): boolean => /(^|_)(pass_rate|rate)$/i.test(col);

export const formatRate = (value: number): string => `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;

export const humanizeHeader = (col: string): string =>
	col.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const formatObject = (value: Record<string, unknown>): string => {
	const entries = Object.entries(value);
	if (!entries.length) return '—';
	return entries
		.map(([key, val]) => {
			if (val && typeof val === 'object' && !Array.isArray(val)) {
				const cell = val as Record<string, unknown>;
				if ('passed' in cell && 'attempted' in cell) return `${key} ${cell.passed}/${cell.attempted}`;
				return `${key}: ${formatObject(cell)}`;
			}
			return `${key}=${formatCell(val)}`;
		})
		.join(', ');
};

export function formatCell(value: unknown, col: string = ''): string {
	if (value === null || value === undefined || value === '') return '—';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (typeof value === 'number') {
		if (isRateColumn(col) && value >= 0 && value <= 1) return formatRate(value);
		return Number.isInteger(value) ? value.toString() : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	}
	if (Array.isArray(value)) return value.length ? value.map((v) => formatCell(v)).join(', ') : '—';
	if (typeof value === 'object') return formatObject(value as Record<string, unknown>);
	return String(value);
}

/** `[67.6, 100.0]`: an interval of fractions, shown in percent. */
export function formatInterval(ci: [number, number] | null | undefined, scale = 100, digits = 1): string {
	if (!ci) return 'n/a';
	return `[${(ci[0] * scale).toFixed(digits)}, ${(ci[1] * scale).toFixed(digits)}]`;
}

/** `87.5% [52.9, 97.8]`: a pass rate with its interval, or `—` when nothing was graded. */
export function formatRateWithCi(rate: number | null, ci: [number, number] | null): string {
	if (rate === null || rate === undefined) return '—';
	return `${formatRate(rate)} ${formatInterval(ci)}`;
}

/** `0.412 [0.301, 0.563]`: passes per minute with its delta-method interval. */
export function formatPpm(value: number | null, ci: [number, number] | null): string {
	if (value === null || value === undefined) return '—';
	return `${value.toFixed(3)} ${formatInterval(ci, 1, 3)}`;
}

/** `+12.5 pp`: a difference of fractions, in percentage points with a sign. */
export function formatDiff(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	const pp = value * 100;
	return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}

export function formatP(p: number | null): string {
	if (p === null || p === undefined) return '—';
	return p < 0.001 ? '<0.001' : p.toFixed(3);
}

export type PairVerdict = 'different' | 'not different' | 'underpowered' | 'not tested';

/** What a pair's test concluded, at the Holm-corrected level. */
export function pairVerdict(pair: ComparePair): PairVerdict {
	if (pair.p === null) return 'not tested';
	if (pair.significant) return 'different';
	return pair.underpowered ? 'underpowered' : 'not different';
}

/** The rows of each block, in the order the backend ranked them within it. */
export function rowsByBlock(rows: CompareRow[]): Map<string, CompareRow[]> {
	const out = new Map<string, CompareRow[]>();
	for (const row of rows) {
		const list = out.get(row.block) ?? [];
		list.push(row);
		out.set(row.block, list);
	}
	return out;
}

/** The facts that identify a block, for its header; the window first when there is one. */
export function blockFacts(block: CompareBlock): { label: string; value: string }[] {
	const facts = [
		{ label: 'Tier', value: block.tier },
		{ label: 'Benchmark', value: block.benchmark || '?' },
		{ label: 'System prompt', value: block.system },
		{ label: 'Adapter', value: block.adapter },
		{ label: 'Revision', value: block.dataset_revision ?? '—' }
	];
	if (block.item_window) facts.unshift({ label: 'Release-date window', value: block.item_window });
	return facts;
}
