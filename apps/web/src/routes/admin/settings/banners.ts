import type { Banner } from '@/lib/types';

export const BANNER_TYPES = ['info', 'warning', 'error', 'success'] as const;

export const newBanner = (): Banner => ({
	id: crypto.randomUUID(),
	type: '',
	title: '',
	content: '',
	dismissible: true,
	timestamp: Math.floor(Date.now() / 1000)
});

/** The "+" button does nothing while the last banner is still blank, so blanks cannot pile up. */
export const canAddBanner = (banners: Banner[]): boolean => banners.length === 0 || banners[banners.length - 1]?.content !== '';

/**
 * Moves one banner by `delta` places, clamped to the list. The Svelte tab
 * reorders by dragging (SortableJS); a drag is not keyboard-reachable, so the
 * port uses up/down buttons and this is what they call.
 */
export const moveBanner = (banners: Banner[], index: number, delta: number): Banner[] => {
	const target = index + delta;
	if (index < 0 || index >= banners.length || target < 0 || target >= banners.length || delta === 0) return banners;
	const next = [...banners];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
};
