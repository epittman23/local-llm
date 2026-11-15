import { describe, expect, it } from 'vitest';
import { shownTime } from './dates';

describe('shownTime (DAT-5)', () => {
	const now = new Date('2026-11-14T12:00:00').getTime();
	const at = (iso: string) => new Date(iso).getTime() / 1000;

	it('reads a recent time relative, with the exact time beside it', () => {
		const t = shownTime(at('2026-11-14T09:00:00'), now);
		expect(t.label).toBe('3 hours ago');
		expect(t.exact).toBe('2026-11-14 09:00');
		expect(t.iso).toBe(new Date('2026-11-14T09:00:00').toISOString());
	});

	it('reads a time older than a week as its date', () => {
		expect(shownTime(at('2026-10-01T08:30:00'), now)).toMatchObject({ label: '2026-10-01', exact: '2026-10-01 08:30' });
	});
});
