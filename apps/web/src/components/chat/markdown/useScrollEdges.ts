import { useEffect, useState } from 'react';

export type ScrollEdges = {
	start: boolean;
	end: boolean;
	/** Content is hidden on either axis, so the element scrolls: a region the keyboard must reach (A11Y-1, NAV-5). */
	overflows: boolean;
};

/**
 * Which ends of a sideways-scrolling element hide content, kept current as it
 * scrolls, as it is resized and as its content changes (a reply streaming in,
 * KaTeX or highlight.js re-rendering, a web font arriving). The frame around
 * it shades those ends (`scroll-edges` in standard.css, as the shared `Table`
 * does, DAT-6), and it is a tab stop only while it overflows (A11Y-2).
 * Returns the ref to put on the scrolling element.
 */
export function useScrollEdges<T extends HTMLElement>(): [(el: T | null) => void, ScrollEdges] {
	const [el, setEl] = useState<T | null>(null);
	const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false, overflows: false });
	useEffect(() => {
		if (!el) return;
		const measure = () => {
			const start = el.scrollLeft > 0;
			const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
			const overflows = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
			setEdges((was) =>
				was.start === start && was.end === end && was.overflows === overflows ? was : { start, end, overflows }
			);
		};
		measure();
		el.addEventListener('scroll', measure, { passive: true });
		// happy-dom, jsdom and old engines have no ResizeObserver.
		const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		resized?.observe(el);
		const changed = new MutationObserver(measure);
		changed.observe(el, { childList: true, subtree: true, characterData: true });
		window.addEventListener('resize', measure);
		document.fonts?.addEventListener('loadingdone', measure);
		void document.fonts?.ready.then(measure);
		return () => {
			el.removeEventListener('scroll', measure);
			resized?.disconnect();
			changed.disconnect();
			window.removeEventListener('resize', measure);
			document.fonts?.removeEventListener('loadingdone', measure);
		};
	}, [el]);
	return [setEl, edges];
}
