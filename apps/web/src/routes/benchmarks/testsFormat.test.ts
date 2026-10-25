import { describe, expect, it } from 'vitest';
import type { DatasetStatus } from '@/lib/apis/benchmarks';
import { calibrationText, datasetEventText } from './testsFormat';

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
