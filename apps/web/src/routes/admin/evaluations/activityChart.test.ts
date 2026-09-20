import { describe, expect, it } from 'vitest';
import { activityBuckets, isEmptyActivity } from './activityChart';

const days = (start: string, n: number) =>
	Array.from({ length: n }, (_, i) => {
		const d = new Date(start);
		d.setUTCDate(d.getUTCDate() + i);
		return { date: d.toISOString().split('T')[0], won: 1, lost: 2 };
	});

describe('activityBuckets', () => {
	it('is one bar per day when not weekly', () => {
		const out = activityBuckets(days('2026-09-14', 3), false);
		expect(out).toHaveLength(3);
		expect(out[0]).toEqual({ label: 'Sep 14', won: 1, lost: 2 });
	});
	it('stays daily for a week or less even when weekly is asked for', () => {
		expect(activityBuckets(days('2026-09-14', 7), true)).toHaveLength(7);
	});
	it('sums Monday-started weeks (2026-09-14 is a Monday)', () => {
		// Mon 14th .. Sun 27th = exactly two weeks; then Mon 28th starts a third.
		const out = activityBuckets(days('2026-09-14', 15), true);
		expect(out.map((b) => [b.label, b.won, b.lost])).toEqual([
			['Sep 14', 7, 14],
			['Sep 21', 7, 14],
			['Sep 28', 1, 2]
		]);
	});
	it('puts a Sunday in the week that started the Monday before', () => {
		const out = activityBuckets(days('2026-09-20', 9), true); // Sun 20th .. Mon 28th
		expect(out[0]).toMatchObject({ label: 'Sep 14', won: 1 });
		expect(out[1]).toMatchObject({ label: 'Sep 21', won: 7 });
	});
	it('orders weeks oldest first', () => {
		const out = activityBuckets([...days('2026-09-21', 8)].reverse(), true);
		expect(out.map((b) => b.label)).toEqual(['Sep 21', 'Sep 28']);
	});
});

describe('isEmptyActivity', () => {
	it('is empty for no rows or all zeros', () => {
		expect(isEmptyActivity([])).toBe(true);
		expect(isEmptyActivity([{ date: 'x', won: 0, lost: 0 }])).toBe(true);
		expect(isEmptyActivity([{ date: 'x', won: 0, lost: 1 }])).toBe(false);
	});
});
