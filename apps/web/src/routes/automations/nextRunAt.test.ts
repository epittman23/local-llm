import { describe, expect, it } from 'vitest';
import { nextRunAt } from './automationModel';

describe('nextRunAt (#324)', () => {
	it('is the next computed run of an active automation', () => {
		expect(nextRunAt({ is_active: true, next_runs: [5, 9], next_run_at: 7 })).toBe(5);
		expect(nextRunAt({ is_active: true, next_runs: null, next_run_at: 7 })).toBe(7);
		expect(nextRunAt({ is_active: true, next_runs: [], next_run_at: null })).toBeNull();
	});
	it('is none for a paused automation, whatever its rule says', () => {
		expect(nextRunAt({ is_active: false, next_runs: [5], next_run_at: 7 })).toBeNull();
	});
});
