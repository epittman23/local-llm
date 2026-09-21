import { describe, expect, it } from 'vitest';
import type { Banner } from '@/lib/types';
import { canAddBanner, moveBanner, newBanner } from './banners';

const b = (id: string, content = 'x'): Banner => ({ id, type: 'info', content, timestamp: 1 });

describe('newBanner', () => {
	it('is blank, dismissible, timestamped in seconds, with its own id each time', () => {
		const a = newBanner();
		expect(a).toMatchObject({ type: '', title: '', content: '', dismissible: true });
		expect(a.timestamp).toBeLessThan(Date.now());
		expect(a.timestamp).toBeGreaterThan(1_600_000_000);
		expect(newBanner().id).not.toBe(a.id);
	});
});

describe('canAddBanner', () => {
	it('allows an empty list or a filled last banner, but not a blank one', () => {
		expect(canAddBanner([])).toBe(true);
		expect(canAddBanner([b('1', 'hello')])).toBe(true);
		expect(canAddBanner([b('1', 'hello'), b('2', '')])).toBe(false);
	});
});

describe('moveBanner', () => {
	const list = [b('1'), b('2'), b('3')];
	it('swaps with the neighbour', () => {
		expect(moveBanner(list, 1, -1).map((x) => x.id)).toEqual(['2', '1', '3']);
		expect(moveBanner(list, 1, 1).map((x) => x.id)).toEqual(['1', '3', '2']);
	});
	it('does nothing past either end, and does not mutate', () => {
		expect(moveBanner(list, 0, -1)).toBe(list);
		expect(moveBanner(list, 2, 1)).toBe(list);
		expect(list.map((x) => x.id)).toEqual(['1', '2', '3']);
	});
});
