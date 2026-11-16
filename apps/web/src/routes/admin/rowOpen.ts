import type { MouseEvent } from 'react';

/**
 * A table row that opens something by pointer anywhere on it (NAV-5): its
 * name cell holds the button that opens it from the keyboard. A click on a
 * control in the row (that button, a menu trigger) or in a menu the row
 * renders through a portal, which React still bubbles to the row, is left
 * to that control.
 */
export function openRow(open: () => void) {
	return (event: MouseEvent<HTMLElement>) => {
		const target = event.target as Element;
		if (!event.currentTarget.contains(target)) return;
		if (target.closest('button, a, input, [role="menuitem"]')) return;
		open();
	};
}
