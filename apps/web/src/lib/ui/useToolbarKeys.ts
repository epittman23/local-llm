import { type FocusEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';

/**
 * NAV-5: a toolbar is one tab stop. Spread the result on the `role="toolbar"`
 * element and mark each tool `data-tool`: only the current tool is in the
 * page's tab order, the arrow keys (wrapping), Home and End move between the
 * tools, and Escape calls `onEscape`, which returns focus to what the tools
 * act on. Keys from a popover or menu a tool opened reach the toolbar through
 * React's portals, and are left to it.
 */
export function useToolbarKeys(onEscape: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	const [current, setCurrent] = useState(0);
	const tools = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? []);
	useLayoutEffect(() => {
		tools().forEach((tool, i) => {
			tool.tabIndex = i === current ? 0 : -1;
		});
	});
	const onKeyDown = (e: KeyboardEvent) => {
		if (!ref.current?.contains(e.target as Node)) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onEscape();
			return;
		}
		const list = tools();
		const at = list.indexOf(document.activeElement as HTMLElement);
		if (at < 0) return;
		const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key];
		if (next === undefined) return;
		e.preventDefault();
		const to = (next + list.length) % list.length;
		list[to].focus();
		setCurrent(to);
	};
	const onFocus = (e: FocusEvent) => {
		const at = tools().indexOf(e.target as HTMLElement);
		if (at >= 0) setCurrent(at);
	};
	return { ref, onKeyDown, onFocus };
}
