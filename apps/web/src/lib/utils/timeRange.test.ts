import { describe, expect, it } from 'vitest';
import { getTimeRange } from './api-helpers';

const secs = (d: Date) => d.getTime() / 1000;

describe('getTimeRange', () => {
	const now = new Date(2026, 9, 1, 9, 0); // 1 Oct 2026, 09:00
	it('today and yesterday by calendar day, across a month boundary', () => {
		expect(getTimeRange(secs(new Date(2026, 9, 1, 0, 5)), now)).toBe('Today');
		expect(getTimeRange(secs(new Date(2026, 8, 30, 23, 0)), now)).toBe('Yesterday');
	});
	it('then the last week, the last month, the month, the year', () => {
		expect(getTimeRange(secs(new Date(2026, 8, 27)), now)).toBe('Previous 7 days');
		expect(getTimeRange(secs(new Date(2026, 8, 10)), now)).toBe('Previous 30 days');
		expect(getTimeRange(secs(new Date(2026, 1, 3)), now)).toBe('February');
		expect(getTimeRange(secs(new Date(2025, 1, 3)), now)).toBe('2025');
	});
});
