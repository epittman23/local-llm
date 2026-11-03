import type { Banner } from '@/lib/types';

/** Where dismissed banner ids are remembered, as the original app kept them. */
export const DISMISSED_BANNERS_KEY = 'dismissedBannerIds';

/** The banners from `/configs/banners`, or none when the reply is not a list of them. */
export const bannerList = (data: unknown): Banner[] =>
	Array.isArray(data)
		? data.filter((b): b is Banner => typeof b?.id === 'string' && typeof b?.content === 'string')
		: [];

/** The ids this browser dismissed; none if storage is unavailable or holds something else. */
export function readDismissedBannerIds(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage) {
	try {
		const ids = JSON.parse(storage?.getItem(DISMISSED_BANNERS_KEY) ?? '[]');
		return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * Remember a dismissed banner, keeping only ids of banners that still exist
 * so the list does not grow forever. Returns what was stored.
 */
export function rememberDismissedBanner(
	id: string,
	banners: Banner[],
	storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage
): string[] {
	const ids = [id, ...readDismissedBannerIds(storage)].filter(
		(x, i, all) => all.indexOf(x) === i && banners.some((b) => b.id === x)
	);
	try {
		storage?.setItem(DISMISSED_BANNERS_KEY, JSON.stringify(ids));
	} catch {
		/* storage full or blocked: the banner stays closed for this page only */
	}
	return ids;
}

/** The banners still to show: neither dismissed in this browser nor closed on this page. */
export const visibleBanners = (banners: Banner[], dismissed: string[], closed: string[]) =>
	banners.filter((b) => !dismissed.includes(b.id) && !closed.includes(b.id));

/** A banner's "Learn More" link, only when it is an http(s) URL. */
export function bannerLink(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
	} catch {
		return null;
	}
}
