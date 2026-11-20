import type { CompareBlock, ComparePair, CompareRow } from '@/lib/apis/benchmarks';
import { dayjs } from '@/lib/utils/dates';

/**
 * Pure formatting rules for the Compare page, kept apart from the components
 * so they can be unit-tested. Rates arrive as fractions and intervals as
 * `[lo, hi]` pairs; the page never shows a rate without its counts or its
 * interval. DAT-2: each column has one precision, figures are right-aligned,
 * the unit is in the heading ("Peak VRAM, MiB"), not in every cell, and a
 * missing value is an en dash.
 */

export const isRateColumn = (col: string): boolean => /(^|_)(pass_rate|rate)$/i.test(col);

/** `78.3`: a fraction in percent, always one decimal; the % is in the heading. */
export const formatRate = (value: number): string => (value * 100).toFixed(1);

export const humanizeHeader = (col: string): string =>
	col.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const BENCHMARK_NAMES: Record<string, string> = {
	humanevalplus: 'HumanEval+',
	mbppplus: 'MBPP+',
	ds1000: 'DS-1000',
	livecodebench: 'LiveCodeBench'
};

/** A benchmark as its authors write it: `humanevalplus` is "HumanEval+". */
export const benchmarkName = (benchmark: string): string => BENCHMARK_NAMES[benchmark] ?? benchmark;

/**
 * How a column's values are shown: `text` as given, `id` monospaced, `count`
 * a right-aligned "47/60", `int` with thousands separators, `fixed` at
 * `digits` decimals, `rate` a fraction in percent, `time` a record's absolute
 * time (DAT-5).
 */
export type ColumnKind = 'text' | 'id' | 'count' | 'int' | 'fixed' | 'rate' | 'time';
export type ColumnSpec = { label: string; kind: ColumnKind; digits?: number };

/** The known keys of the benchmark, failures and serving views, as words with the unit after a comma. */
const COLUMNS: Record<string, ColumnSpec> = {
	model: { label: 'Model', kind: 'text' },
	alias: { label: 'Alias', kind: 'text' },
	config_id: { label: 'Configuration', kind: 'id' },
	tier: { label: 'Tier', kind: 'text' },
	system: { label: 'System prompt', kind: 'text' },
	benchmark: { label: 'Benchmark', kind: 'text' },
	item_id: { label: 'Item', kind: 'id' },
	outcome: { label: 'Outcome', kind: 'text' },
	reason: { label: 'Reason', kind: 'text' },
	reasoning_chars: { label: 'Reasoning, characters', kind: 'int' },
	suite_run_id: { label: 'Suite run', kind: 'id' },
	ngl: { label: 'GPU layers', kind: 'int' },
	parallel: { label: 'Parallel slots', kind: 'int' },
	spec: { label: 'Speculative decoding', kind: 'text' },
	override_tensors: { label: 'Tensor overrides', kind: 'id' },
	fused_gdn: { label: 'Fused GDN', kind: 'text' },
	prefill_tps: { label: 'Prefill, t/s', kind: 'fixed', digits: 1 },
	gen_tps: { label: 'Gen, t/s', kind: 'fixed', digits: 2 },
	acceptance: { label: 'Draft acceptance, %', kind: 'rate' },
	source: { label: 'Source', kind: 'text' },
	peak_vram_mib: { label: 'Peak VRAM, MiB', kind: 'int' },
	vram_headroom_mib: { label: 'VRAM headroom, MiB', kind: 'int' },
	build: { label: 'llama.cpp build', kind: 'id' },
	started_at: { label: 'Started', kind: 'time' },
	cpu_resident_layers: { label: 'CPU-resident layers', kind: 'int' },
	ms_per_token: { label: 'Time per token, ms', kind: 'fixed', digits: 1 },
	cpu_bandwidth_gib_s: { label: 'CPU bandwidth, GiB/s', kind: 'fixed', digits: 1 },
	headroom_in_layers: { label: 'Headroom, layers', kind: 'int' }
};

const asNumber = (value: unknown): number | null => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
	return null;
};

/**
 * A column's heading and format: from the known keys, then the benchmark
 * view's `<benchmark>_passed` / `<benchmark>_pass_rate`, then, for a key the
 * page has not met, its words and a format read from its values.
 */
export function columnSpec(col: string, values: unknown[] = []): ColumnSpec {
	const known = COLUMNS[col];
	if (known) return known;
	const rate = /^(.+)_pass_rate$/.exec(col);
	if (rate) return { label: `${benchmarkName(rate[1])} pass rate, %`, kind: 'rate' };
	const passed = /^(.+)_passed$/.exec(col);
	if (passed) return { label: `${benchmarkName(passed[1])} passed`, kind: 'count' };
	if (isRateColumn(col)) return { label: `${humanizeHeader(col)}, %`, kind: 'rate' };
	const present = values.filter((v) => v !== null && v !== undefined && v !== '');
	const numbers = present.map(asNumber);
	if (present.length && numbers.every((n) => n !== null)) {
		const whole = numbers.every((n) => Number.isInteger(n));
		return whole
			? { label: humanizeHeader(col), kind: 'int' }
			: { label: humanizeHeader(col), kind: 'fixed', digits: 2 };
	}
	return { label: humanizeHeader(col), kind: 'text' };
}

/** Right-aligned, tabular columns (DAT-1, DAT-2). */
export const isNumericKind = (kind: ColumnKind): boolean =>
	kind === 'count' || kind === 'int' || kind === 'fixed' || kind === 'rate';

/** What a column sorts on: the number inside a numeric string, so "18" sorts below "120". */
export function sortValue(value: unknown, kind: ColumnKind): unknown {
	if (kind === 'int' || kind === 'fixed' || kind === 'rate') return asNumber(value) ?? value;
	if (kind === 'count' && typeof value === 'string') {
		const m = /^(\d+)\s*\/\s*(\d+)$/.exec(value);
		return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : value;
	}
	return value;
}

const thousands = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `2026-11-14 10:24` from epoch seconds or an ISO string. */
export function formatTime(value: number | string): string {
	const date = typeof value === 'number' ? dayjs(value * 1000) : dayjs(value);
	return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : String(value);
}

const formatObject = (value: Record<string, unknown>): string => {
	const entries = Object.entries(value);
	if (!entries.length) return '–';
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

/** A cell in its column's format; a missing value is an en dash (DAT-2). */
export function formatCell(value: unknown, col: string = '', spec: ColumnSpec = columnSpec(col)): string {
	if (value === null || value === undefined || value === '') return '–';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (spec.kind === 'time' && (typeof value === 'number' || typeof value === 'string')) return formatTime(value);
	if (col === 'benchmark' && typeof value === 'string') return benchmarkName(value);
	const n = asNumber(value);
	if (n !== null) {
		if (spec.kind === 'rate' && n >= 0 && n <= 1) return formatRate(n);
		if (spec.kind === 'int') return thousands.format(n);
		if (spec.kind === 'fixed') return n.toFixed(spec.digits ?? 2);
		if (typeof value === 'number') return Number.isInteger(n) ? thousands.format(n) : n.toFixed(2);
	}
	if (Array.isArray(value)) return value.length ? value.map((v) => formatCell(v)).join(', ') : '–';
	if (typeof value === 'object') return formatObject(value as Record<string, unknown>);
	return String(value);
}

/** `[67.6, 100.0]`: an interval of fractions, shown in percent. */
export function formatInterval(ci: [number, number] | null | undefined, scale = 100, digits = 1): string {
	if (!ci) return 'n/a';
	return `[${(ci[0] * scale).toFixed(digits)}, ${(ci[1] * scale).toFixed(digits)}]`;
}

/** `87.5 [52.9, 97.8]`: a pass rate in percent with its interval, or `–` when nothing was graded. */
export function formatRateWithCi(rate: number | null, ci: [number, number] | null): string {
	if (rate === null || rate === undefined) return '–';
	return `${formatRate(rate)} ${formatInterval(ci)}`;
}

/** `0.412 [0.301, 0.563]`: passes per minute with its delta-method interval. */
export function formatPpm(value: number | null, ci: [number, number] | null): string {
	if (value === null || value === undefined) return '–';
	return `${value.toFixed(3)} ${formatInterval(ci, 1, 3)}`;
}

/** `+12.5`: a difference of fractions, in percentage points with a sign; the pp is in the heading. */
export function formatDiff(value: number | null | undefined): string {
	if (value === null || value === undefined) return '–';
	const pp = value * 100;
	return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}`;
}

/** `+3.3 [-1.3, 8.0]`: a paired difference with its interval, in percentage points. */
export function formatDiffWithCi(value: number | null, ci: [number, number] | null): string {
	if (value === null || value === undefined) return '–';
	return ci ? `${formatDiff(value)} ${formatInterval(ci)}` : formatDiff(value);
}

export function formatP(p: number | null): string {
	if (p === null || p === undefined) return '–';
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
		{ label: 'Benchmark', value: block.benchmark ? benchmarkName(block.benchmark) : '?' },
		{ label: 'System prompt', value: block.system },
		{ label: 'Adapter', value: block.adapter },
		{ label: 'Revision', value: block.dataset_revision ?? '–' }
	];
	if (block.item_window) facts.unshift({ label: 'Release-date window', value: block.item_window });
	return facts;
}

const UNSET = '(unset)';

/**
 * The flags that tell a block's configurations apart, and the ones they all
 * share (#939). A flag missing from a row counts as unset; a flag every row
 * leaves unset is in neither list.
 */
export function splitFlags(rows: Pick<CompareRow, 'flags'>[]): {
	varying: string[];
	shared: { flag: string; value: string }[];
} {
	const keys: string[] = [];
	for (const row of rows) for (const key of Object.keys(row.flags ?? {})) if (!keys.includes(key)) keys.push(key);
	const varying: string[] = [];
	const shared: { flag: string; value: string }[] = [];
	for (const key of keys) {
		const values = [...new Set(rows.map((row) => row.flags?.[key] ?? UNSET))];
		if (values.length > 1) varying.push(key);
		else if (values[0] !== UNSET) shared.push({ flag: key, value: values[0] });
	}
	return { varying, shared };
}

/** A flag's value in a cell: `(unset)` reads as an en dash. */
export const flagValue = (flags: Record<string, string> | undefined, key: string): string => {
	const value = flags?.[key];
	return value === undefined || value === UNSET ? '–' : value;
};

/** Whether every set value of a flag in these rows is a number, so its column is right-aligned. */
export const isNumericFlag = (rows: Pick<CompareRow, 'flags'>[], key: string): boolean => {
	const values = rows.map((row) => row.flags?.[key]).filter((v) => v !== undefined && v !== UNSET);
	return values.length > 0 && values.every((v) => asNumber(v) !== null);
};

/** `ngl=22 batch=1024 …`: a configuration's set flags, for the tip on its id. */
export const flagsText = (flags: Record<string, string> | undefined): string =>
	Object.entries(flags ?? {})
		.filter(([, v]) => v !== UNSET)
		.map(([k, v]) => `${k}=${v}`)
		.join(' ') || 'No flags recorded';

/** A configuration in a sentence or an option: "qwen3.8-27b @ bd04a851 · ngl 18, batch 1024". */
export function configLabel(row: Pick<CompareRow, 'model' | 'config_id' | 'flags'>, varying: string[]): string {
	const differs = varying.map((key) => `${key} ${flagValue(row.flags, key)}`).join(', ');
	return `${row.model} @ ${row.config_id}${differs ? ` · ${differs}` : ''}`;
}

/** The configurations in a config view, once each, in the order they first appear. */
export function configurations(rows: CompareRow[]): CompareRow[] {
	const seen = new Map<string, CompareRow>();
	for (const row of rows) if (!seen.has(row.config_id)) seen.set(row.config_id, row);
	return [...seen.values()];
}

/** "qwen3.8-27b @ 47714ce1" as "47714ce1" when every configuration in the block runs one model. */
export const pairSide = (label: string, oneModel: boolean): string => (oneModel ? label.replace(/^.* @ /, '') : label);

export type NoteParts = {
	/** The note as the server sent it, unique among a response's notes. */
	raw: string;
	tone: 'warning' | 'note';
	/** Its sentence in runs of text and code, each with its offset in the sentence as a key. */
	parts: { key: number; text: string; code: boolean }[];
};

/**
 * A backend note without its markdown (#1043): the `> warning:` / `> note:`
 * prefix becomes its tone, and backticked ids become code.
 */
export function parseNote(note: string): NoteParts {
	const m = /^\s*(?:>\s*)?(warning|note)\s*:\s*/i.exec(note);
	const tone = m && m[1].toLowerCase() === 'warning' ? 'warning' : 'note';
	const body = m ? note.slice(m[0].length) : note.replace(/^\s*>\s*/, '');
	const parts: NoteParts['parts'] = [];
	let offset = 0;
	for (const part of body.split(/(`[^`]+`)/)) {
		if (part) {
			const code = part.length > 1 && part.startsWith('`') && part.endsWith('`');
			parts.push({ key: offset, text: code ? part.slice(1, -1) : part, code });
		}
		offset += part.length;
	}
	return { raw: note, tone, parts };
}
