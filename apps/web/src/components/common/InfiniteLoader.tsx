import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Ports common/Loader.svelte: fires `onVisible` when it scrolls into view, so a
 * list can append its next page. `root` is the scrolling list, not the window,
 * when the loader sits inside an overflow container.
 */
export function InfiniteLoader({ onVisible, children }: { onVisible: () => void; children?: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const callback = useRef(onVisible);
	callback.current = onVisible;

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) callback.current();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return <div ref={ref}>{children}</div>;
}
