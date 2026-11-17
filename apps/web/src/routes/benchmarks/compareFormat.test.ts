import { describe, expect, it } from 'vitest';
import type { CompareBlock, ComparePair, CompareRow } from '@/lib/apis/benchmarks';
import {
	benchmarkName,
	blockFacts,
	columnSpec,
	configLabel,
	configurations,
	flagsText,
	flagValue,
	formatCell,
	formatDiff,
	formatDiffWithCi,
	formatInterval,
	formatP,
	formatPpm,
	formatRateWithCi,
	formatTime,
	isNumericFlag,
	isNumericKind,
	pairSide,
	pairVerdict,
	parseNote,
	rowsByBlock,
	sortValue,
	splitFlags
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
	it('shows a rate with its interval, never alone, at one decimal with the % in the heading (#1041)', () => {
		expect(formatRateWithCi(0.875, [0.529, 0.978])).toBe('87.5 [52.9, 97.8]');
		expect(formatRateWithCi(1, [0.6756, 1])).toBe('100.0 [67.6, 100.0]');
		expect(formatRateWithCi(null, null)).toBe('–');
		expect(formatInterval(null)).toBe('n/a');
	});

	it('formats passes per minute, differences and p-values', () => {
		expect(formatPpm(0.4123, [0.3011, 0.5634])).toBe('0.412 [0.301, 0.563]');
		expect(formatDiff(0.125)).toBe('+12.5');
		expect(formatDiff(-0.05)).toBe('-5.0');
		expect(formatDiff(null)).toBe('–');
		expect(formatP(0.0004)).toBe('<0.001');
		expect(formatP(0.21875)).toBe('0.219');
		expect(formatP(null)).toBe('–');
		expect(formatPpm(null, null)).toBe('–');
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
		expect(blockFacts(block())[1]).toEqual({ label: 'Benchmark', value: 'DS-1000' });
		expect(blockFacts(block({ benchmark: '', dataset_revision: null })).map((f) => f.value)).toEqual([
			'smoke',
			'?',
			'-',
			'abc',
			'–'
		]);
		expect(blockFacts(block({ item_window: '2025-01-01..' }))[0]).toEqual({
			label: 'Release-date window',
			value: '2025-01-01..'
		});
	});

	it("formats generic cells in their column's one precision (#1041, DAT-2)", () => {
		expect(formatCell(0.72, 'pass_rate')).toBe('72.0');
		expect(formatCell(0.5, 'ds1000_pass_rate')).toBe('50.0');
		expect(formatCell('1/2', 'ds1000_passed')).toBe('1/2');
		expect(formatCell(null)).toBe('–');
		expect(formatCell('')).toBe('–');
		expect(formatCell(true)).toBe('Yes');
		expect(formatCell(false)).toBe('No');
		expect(formatCell(3.075, 'gen_tps')).toBe('3.08');
		expect(formatCell(75.157, 'prefill_tps')).toBe('75.2');
		expect(formatCell(5658, 'peak_vram_mib')).toBe('5,658');
		expect(formatCell('31.7', 'cpu_bandwidth_gib_s')).toBe('31.7');
		expect(formatCell(257.7319, 'ms_per_token')).toBe('257.7');
		expect(formatCell(0.705, 'acceptance')).toBe('70.5');
		expect(formatCell('humanevalplus', 'benchmark')).toBe('HumanEval+');
		expect(formatCell(12345, 'unknown')).toBe('12,345');
		expect(formatCell(1.23456, 'unknown')).toBe('1.23');
		expect(formatCell([], 'x')).toBe('–');
		expect(formatCell([1, 'a'], 'x')).toBe('1, a');
		expect(formatCell({}, 'x')).toBe('–');
		expect(formatCell({ ds1000: { passed: 1, attempted: 2 }, deep: { a: 1 }, flag: 'on' }, 'x')).toBe(
			'ds1000 1/2, deep: a=1, flag=on'
		);
	});

	it("shows a record's time absolutely (DAT-5), from epoch seconds or ISO", () => {
		const at = new Date(2026, 10, 14, 10, 24);
		expect(formatTime(at.getTime() / 1000)).toBe('2026-11-14 10:24');
		expect(formatTime(at.toISOString())).toBe('2026-11-14 10:24');
		expect(formatCell(at.getTime() / 1000, 'started_at')).toBe('2026-11-14 10:24');
		expect(formatTime('not a time')).toBe('not a time');
	});

	it('names columns in words with the unit after a comma, and reads unknown ones from their values (#1042)', () => {
		expect(columnSpec('peak_vram_mib')).toEqual({ label: 'Peak VRAM, MiB', kind: 'int' });
		expect(columnSpec('cpu_bandwidth_gib_s').label).toBe('CPU bandwidth, GiB/s');
		expect(columnSpec('prefill_tps').label).toBe('Prefill, t/s');
		expect(columnSpec('started_at')).toEqual({ label: 'Started', kind: 'time' });
		expect(columnSpec('humanevalplus_pass_rate')).toEqual({ label: 'HumanEval+ pass rate, %', kind: 'rate' });
		expect(columnSpec('mbppplus_passed')).toEqual({ label: 'MBPP+ passed', kind: 'count' });
		expect(columnSpec('new_thing', [1, 2, null])).toEqual({ label: 'New Thing', kind: 'int' });
		expect(columnSpec('new_ratio', ['1.5', 2])).toEqual({ label: 'New Ratio', kind: 'fixed', digits: 2 });
		expect(columnSpec('new_words', ['a', 1])).toEqual({ label: 'New Words', kind: 'text' });
		expect(columnSpec('nothing', [])).toEqual({ label: 'Nothing', kind: 'text' });
		expect(columnSpec('pass_rate')).toEqual({ label: 'Pass Rate, %', kind: 'rate' });
		expect(benchmarkName('other')).toBe('other');
	});

	it('right-aligns figures and sorts numeric strings as numbers', () => {
		expect(isNumericKind('int')).toBe(true);
		expect(isNumericKind('count')).toBe(true);
		expect(isNumericKind('id')).toBe(false);
		expect(sortValue('18', 'int')).toBe(18);
		expect(sortValue('n/a', 'fixed')).toBe('n/a');
		expect(sortValue('47/60', 'count')).toBeCloseTo(0.7833, 3);
		expect(sortValue('x/0', 'count')).toBe('x/0');
		expect(sortValue('bd04a851', 'id')).toBe('bd04a851');
	});

	it("splits a block's flags into the ones that vary and the ones all share, hiding unset (#939)", () => {
		const rows: { flags: Record<string, string> }[] = [
			{ flags: { ngl: '22', batch: '1024', fa: 'on', moe: '(unset)' } },
			{ flags: { ngl: '20', batch: '512', fa: 'on', moe: '(unset)' } },
			{ flags: { ngl: '18', batch: '512', fa: 'on', moe: '(unset)', extra: '--foo' } }
		];
		expect(splitFlags(rows)).toEqual({ varying: ['ngl', 'batch', 'extra'], shared: [{ flag: 'fa', value: 'on' }] });
		expect(splitFlags([rows[0]]).varying).toEqual([]);
		expect(flagValue(rows[0].flags, 'moe')).toBe('–');
		expect(flagValue(rows[0].flags, 'extra')).toBe('–');
		expect(flagValue(rows[0].flags, 'ngl')).toBe('22');
		expect(isNumericFlag(rows, 'ngl')).toBe(true);
		expect(isNumericFlag(rows, 'extra')).toBe(false);
		expect(isNumericFlag(rows, 'moe')).toBe(false);
		expect(flagsText(rows[0].flags)).toBe('ngl=22 batch=1024 fa=on');
		expect(flagsText({})).toBe('No flags recorded');
	});

	it('names a configuration by its model, id and differing flags, once each (#1044)', () => {
		const rows = [
			{ block: 'x', model: 'm', config_id: 'aaa', flags: { ngl: '22' } },
			{ block: 'y', model: 'm', config_id: 'aaa', flags: { ngl: '22' } },
			{ block: 'x', model: 'm', config_id: 'bbb', flags: { ngl: '18' } }
		] as unknown as CompareRow[];
		expect(configurations(rows).map((r) => r.config_id)).toEqual(['aaa', 'bbb']);
		expect(configLabel(rows[2], ['ngl'])).toBe('m @ bbb · ngl 18');
		expect(configLabel(rows[2], [])).toBe('m @ bbb');
	});

	it("writes a paired difference with its interval once, and drops a block's one model (#1112)", () => {
		expect(formatDiffWithCi(0.033, [-0.013, 0.08])).toBe('+3.3 [-1.3, 8.0]');
		expect(formatDiffWithCi(0.033, null)).toBe('+3.3');
		expect(formatDiffWithCi(null, null)).toBe('–');
		expect(pairSide('qwen3.8-27b @ 47714ce1', true)).toBe('47714ce1');
		expect(pairSide('qwen3.8-27b @ 47714ce1', false)).toBe('qwen3.8-27b @ 47714ce1');
	});

	it("turns a note's markdown into its tone and code (#1043)", () => {
		expect(parseNote('> warning: `bd04a851` and `47714ce1` differ in 2 flags (batch, ngl).')).toEqual({
			raw: '> warning: `bd04a851` and `47714ce1` differ in 2 flags (batch, ngl).',
			tone: 'warning',
			parts: [
				{ key: 0, text: 'bd04a851', code: true },
				{ key: 10, text: ' and ', code: false },
				{ key: 15, text: '47714ce1', code: true },
				{ key: 25, text: ' differ in 2 flags (batch, ngl).', code: false }
			]
		});
		expect(parseNote('> note: 2 blocks.').tone).toBe('note');
		expect(parseNote('> plain').parts).toEqual([{ key: 0, text: 'plain', code: false }]);
		expect(parseNote('Warning: bare').tone).toBe('warning');
	});
});
