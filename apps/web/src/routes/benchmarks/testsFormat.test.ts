import { describe, expect, it } from 'vitest';
import type { DatasetStatus } from '@/lib/apis/benchmarks';
import {
	appendNote,
	calibrationText,
	datasetEventText,
	formatBytes,
	incrementLabel,
	missingIncrements,
	windowError
} from './testsFormat';

const event = { benchmark: 'humanevalplus', n_items: 164, revision: 'v0.1.10@42526ec0e7d5', fetched: false };

describe('datasetEventText', () => {
	it('says a vendored dataset is in the repository, whatever the fetched flag says', () => {
		expect(datasetEventText({ ...event, vendored: true })).toBe(
			'humanevalplus: in the repository, verified, 164 items, revision v0.1.10@42526ec0e7d5'
		);
		expect(datasetEventText({ ...event, fetched: true, vendored: true })).toMatch(/in the repository/);
	});

	it('tells a fresh download from one already on disk', () => {
		expect(datasetEventText({ ...event, fetched: true })).toBe(
			'humanevalplus: fetched, 164 items, revision v0.1.10@42526ec0e7d5'
		);
		expect(datasetEventText({ ...event, vendored: false })).toMatch(/already downloaded/);
	});
});

const status = (over: Partial<DatasetStatus>): DatasetStatus => ({
	benchmark: 'mbppplus',
	name: 'MBPP+',
	fetched: true,
	vendored: true,
	n_items: 378,
	revision: 'v0.2.0@b54e76275524',
	fetched_at: null,
	calibrated_at: '2026-10-25T16:00:00Z',
	n_checked: 378,
	n_ungradeable: 1,
	calibration_stale: '',
	...over
});

describe('calibrationText', () => {
	it('counts the gradeable items of a current calibration', () => {
		expect(calibrationText(status({}))).toBe('377/378 gradeable');
	});

	it('says why a calibration is stale, and nothing for a dataset not fetched', () => {
		expect(calibrationText(status({ calibration_stale: 'not calibrated yet' }))).toBe('not calibrated yet');
		expect(calibrationText(status({ fetched: false }))).toBe('-');
		expect(calibrationText(status({ fetched: false, calibration_stale: 'does not match its pinned hash' }))).toBe(
			'does not match its pinned hash'
		);
	});
});

const inc = (name: string, first: string, last: string, fetched = false) => ({
	name,
	bytes: 134303240,
	items: 175,
	first,
	last,
	fetched
});

describe('windows and increments', () => {
	it('formats sizes and labels an increment', () => {
		expect(formatBytes(134303240)).toBe('128 MiB');
		expect(formatBytes(1252609773)).toBe('1.17 GiB');
		expect(incrementLabel(inc('test6.jsonl', '2025-01-04', '2025-04-06', true))).toBe(
			'test6.jsonl: 175 problems, 2025-01-04 to 2025-04-06, 128 MiB (fetched)'
		);
	});

	it('refuses a window without a start or one that ends first', () => {
		expect(windowError('', '')).toBe('');
		expect(windowError('2025-01-05', '')).toBe('');
		expect(windowError('', '2025-01-05')).toMatch(/first date/);
		expect(windowError('2025-02-01', '2025-01-01')).toMatch(/ends before/);
	});

	it('names every unfetched increment the window touches, overlaps included', () => {
		const incs = [
			inc('test4.jsonl', '2023-08-26', '2024-10-05'),
			inc('test5.jsonl', '2024-09-22', '2025-01-04'),
			inc('test6.jsonl', '2025-01-04', '2025-04-06', true)
		];
		expect(missingIncrements(incs, '2025-01-05', '')).toEqual([]);
		expect(missingIncrements(incs, '2025-01-04', '')).toEqual(['test5.jsonl']);
		expect(missingIncrements(incs, '2024-01-01', '2024-01-31')).toEqual(['test4.jsonl']);
		expect(missingIncrements(incs, '', '')).toEqual([]);
	});
});

describe('appendNote', () => {
	it('replaces a running fetch count instead of piling them up', () => {
		let notes: string[] = [];
		notes = appendNote(notes, 'livecodebench: test6.jsonl: downloading 128 MiB');
		notes = appendNote(notes, 'livecodebench: test6.jsonl: 40 of 128 MiB');
		notes = appendNote(notes, 'livecodebench: test6.jsonl: 80 of 128 MiB');
		notes = appendNote(notes, 'livecodebench: test6.jsonl: decoded 25 of 175 problems');
		notes = appendNote(notes, 'livecodebench: test6.jsonl: decoded 50 of 175 problems');
		notes = appendNote(notes, 'livecodebench: test6.jsonl: 175 problems from 2025-01-04 to 2025-04-06');
		expect(notes).toEqual([
			'livecodebench: test6.jsonl: downloading 128 MiB',
			'livecodebench: test6.jsonl: decoded 50 of 175 problems',
			'livecodebench: test6.jsonl: 175 problems from 2025-01-04 to 2025-04-06'
		]);
	});
});
