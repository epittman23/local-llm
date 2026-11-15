import { useEffect } from 'react';

/** Below md, where the app bar shows and toasts sit at the top (FBK-2). */
export const PHONE_QUERY = '(max-width: 767.98px)';

/**
 * The bottom edge of the band at the top of a phone screen that the fixed
 * layers outside the shell (the connection banner, toasts) start below, so
 * they cover none of its controls (FBK-2, OVL-2): the lowest of the app bar
 * (or, where it folds on a short screen, its floating menu button) and the
 * visible part of each element marked `data-page-top` (a page's own header:
 * the shared PageHeader, the chat's model row). A header scrolled out of view
 * no longer counts.
 */
export function topBandBottom(bar: HTMLElement): number {
	const menu = bar.querySelector('button')?.getBoundingClientRect().bottom ?? 0;
	let bottom = Math.max(bar.getBoundingClientRect().bottom, menu);
	for (const top of document.querySelectorAll('[data-page-top]')) {
		const rect = top.getBoundingClientRect();
		if (rect.height === 0 || rect.bottom <= 0) continue;
		bottom = Math.max(bottom, Math.min(rect.bottom, window.innerHeight));
	}
	return Math.ceil(bottom);
}

/**
 * Keeps `--top-band-bottom` on <html> at topBandBottom on a phone, and at 0
 * from md up, where nothing is watched: toasts sit bottom right there and the
 * bar is hidden. Removed with the shell, so /auth and /error start at the top.
 */
export function useTopBand(bar: HTMLElement | null) {
	useEffect(() => {
		if (!bar) return;
		const root = document.documentElement;
		const phone = window.matchMedia(PHONE_QUERY);
		let frame = 0;
		let unwatch: (() => void) | null = null;
		const measure = () => {
			frame = 0;
			root.style.setProperty('--top-band-bottom', `${phone.matches ? topBandBottom(bar) : 0}px`);
		};
		// One measurement per frame: a streaming answer changes the page many times a second.
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		const watch = () => {
			unwatch?.();
			unwatch = null;
			measure();
			if (!phone.matches) return;
			// The bar folds and unfolds with the screen's height; page headers
			// come and go with the route, grow with their content and scroll.
			const resize = new ResizeObserver(schedule);
			resize.observe(bar);
			const mutations = new MutationObserver(schedule);
			mutations.observe(document.body, { childList: true, subtree: true });
			document.addEventListener('scroll', schedule, { capture: true, passive: true });
			window.addEventListener('resize', schedule);
			unwatch = () => {
				resize.disconnect();
				mutations.disconnect();
				document.removeEventListener('scroll', schedule, { capture: true });
				window.removeEventListener('resize', schedule);
			};
		};
		watch();
		phone.addEventListener('change', watch);
		return () => {
			phone.removeEventListener('change', watch);
			unwatch?.();
			if (frame) cancelAnimationFrame(frame);
			root.style.removeProperty('--top-band-bottom');
		};
	}, [bar]);
}
