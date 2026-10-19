import { describe, expect, it } from 'vitest';
import type { CompareBlock, ComparePair, CompareRow } from '@/lib/apis/benchmarks';
import {
	blockFacts,
	formatCell,
	formatDiff,
	formatInterval,
	formatP,
	formatPpm,
	formatRateWithCi,
	pairVerdict,
	rowsByBlock
} from './compareFormat';

const pair = (over: Partial<ComparePair>): ComparePair => ({
	a: 'm @ a',
	b: 'm @ b',
	n_shared: 8,
	mean_diff: 0.125,
	se: 0.1,
	ci: [-0.1, 0.35],
	corr: 0.5,
	test: 'exact McNemar',
	statistic: 1,
	discordant: [2, 1],
	p: 0.4,
	p_holm: 0.4,
	significant: false,
	mde: 0.28,
	mde_holm: 0.28,
	underpowered: true,
	n_clusters: null,
	note: '',
	...over
});

const block = (over: Partial<CompareBlock> = {}): CompareBlock => ({
	key: 'k',
	tier: 'smoke',
	benchmark: 'ds1000',
	adapter: 'abc',
	system: '-',
	item_window: null,
	dataset_revision: 'rev',
	levels: [],
	letters: {},
	holm_m: 0,
	alpha: 0.05,
	pairs: [],
	...over
});

describe('compareFormat', () => {
	it('shows a rate with its interval, never alone', () => {
		expect(formatRateWithCi(0.875, [0.529, 0.978])).toBe('87.5% [52.9, 97.8]');
		expect(formatRateWithCi(1, [0.6756, 1])).toBe('100% [67.6, 100.0]');
		expect(formatRateWithCi(null, null)).toBe('—');
		expect(formatInterval(null)).toBe('n/a');
	});

	it('formats passes per minute, differences and p-values', () => {
		expect(formatPpm(0.4123, [0.3011, 0.5634])).toBe('0.412 [0.301, 0.563]');
		expect(formatDiff(0.125)).toBe('+12.5 pp');
		expect(formatDiff(-0.05)).toBe('-5.0 pp');
		expect(formatP(0.0004)).toBe('<0.001');
		expect(formatP(0.21875)).toBe('0.219');
		expect(formatP(null)).toBe('—');
	});

	it('names a pair by what its test concluded', () => {
		expect(pairVerdict(pair({ significant: true, underpowered: false }))).toBe('different');
		expect(pairVerdict(pair({}))).toBe('underpowered');
		expect(pairVerdict(pair({ underpowered: false }))).toBe('not different');
		expect(pairVerdict(pair({ p: null, underpowered: null }))).toBe('not tested');
	});

	it('keeps the backend order within each block', () => {
		const rows = [
			{ block: 'x', config_id: '1' },
			{ block: 'y', config_id: '2' },
			{ block: 'x', config_id: '3' }
		] as CompareRow[];
		const out = rowsByBlock(rows);
		expect([...out.keys()]).toEqual(['x', 'y']);
		expect(out.get('x')?.map((r) => r.config_id)).toEqual(['1', '3']);
	});

	it('puts the release-date window first in a block header', () => {
		expect(blockFacts(block())[0]).toEqual({ label: 'Tier', value: 'smoke' });
		expect(blockFacts(block({ item_window: '2025-01-01..' }))[0]).toEqual({
			label: 'Release-date window',
			value: '2025-01-01..'
		});
	});

	it('formats generic cells as before', () => {
		expect(formatCell(0.72, 'pass_rate')).toBe('72%');
		expect(formatCell(0.5, 'ds1000_pass_rate')).toBe('50%');
		expect(formatCell('1/2', 'ds1000_passed')).toBe('1/2');
		expect(formatCell(null)).toBe('—');
	});
});
