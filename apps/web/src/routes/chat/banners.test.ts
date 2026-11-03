import { describe, expect, it } from 'vitest';
import type { Banner } from '@/lib/types';
import {
	DISMISSED_BANNERS_KEY,
	bannerLink,
	bannerList,
	readDismissedBannerIds,
	rememberDismissedBanner,
	visibleBanners
} from './banners';

const banner = (id: string, over: Partial<Banner> = {}): Banner => ({
	id,
	type: 'info',
	content: `banner ${id}`,
	dismissible: true,
	timestamp: 0,
	...over
});

const memoryStorage = (initial: Record<string, string> = {}) => {
	const data = { ...initial };
	return {
		data,
		getItem: (k: string) => data[k] ?? null,
		setItem: (k: string, v: string) => {
			data[k] = v;
		}
	};
};

describe('bannerList', () => {
	it('keeps well-formed banners and treats anything else as none', () => {
		expect(bannerList([banner('a'), { id: 1 }, null])).toEqual([banner('a')]);
		expect(bannerList({ items: [], total: 0 })).toEqual([]);
		expect(bannerList(null)).toEqual([]);
	});
});

describe('dismissed banners', () => {
	it('reads what this browser dismissed, and copes with junk or no storage', () => {
		expect(readDismissedBannerIds(memoryStorage({ [DISMISSED_BANNERS_KEY]: '["a",2]' }))).toEqual(['a']);
		expect(readDismissedBannerIds(memoryStorage({ [DISMISSED_BANNERS_KEY]: 'not json' }))).toEqual([]);
		expect(readDismissedBannerIds(undefined)).toEqual([]);
	});

	it('remembers a dismissal and forgets ids of banners that no longer exist', () => {
		const storage = memoryStorage({ [DISMISSED_BANNERS_KEY]: '["gone","b"]' });
		expect(rememberDismissedBanner('a', [banner('a'), banner('b')], storage)).toEqual(['a', 'b']);
		expect(JSON.parse(storage.data[DISMISSED_BANNERS_KEY])).toEqual(['a', 'b']);
	});

	it('still closes the banner when storage refuses the write', () => {
		const storage = {
			getItem: () => null,
			setItem: () => {
				throw new Error('QuotaExceededError');
			}
		};
		expect(rememberDismissedBanner('a', [banner('a')], storage)).toEqual(['a']);
	});
});

describe('visibleBanners', () => {
	it('hides the dismissed and the closed', () => {
		const all = [banner('a'), banner('b'), banner('c')];
		expect(visibleBanners(all, ['a'], ['c']).map((b) => b.id)).toEqual(['b']);
	});
});

describe('bannerLink', () => {
	it('links only to http(s)', () => {
		expect(bannerLink('https://example.com/notes')).toBe('https://example.com/notes');
		expect(bannerLink('javascript:alert(1)')).toBeNull();
		expect(bannerLink('not a url')).toBeNull();
		expect(bannerLink(undefined)).toBeNull();
	});
});
