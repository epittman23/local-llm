import { useRef } from 'react';

// NAV-4: when a dialog closes, focus returns to what opened it. Radix returns
// it only to a DialogTrigger; most dialogs here open from state (a menu item,
// a row's button, a page's own button), and Radix then drops focus on <body>.
// This records the opener as the dialog opens and focuses it again on close.
//
// It records in onOpenAutoFocus because at that moment focus is still on the
// opener: an effect on the dialog's root runs after Radix's FocusScope has
// moved focus inside, and would record the dialog's own first control.

type AutoFocusHandler = ((event: Event) => void) | undefined;

/** The two auto-focus handlers for a Radix dialog's Content, wrapping the caller's own. */
export function useReturnFocus(onOpenAutoFocus: AutoFocusHandler, onCloseAutoFocus: AutoFocusHandler) {
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus(event: Event) {
			// Before the caller's handler, which may move focus itself.
			const active = document.activeElement;
			// A menu item goes when its menu closes; the menu's trigger stays.
			const menu = active?.closest('[role="menu"][id]');
			const trigger = menu && document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`);
			const target = trigger ?? active;
			opener.current = target instanceof HTMLElement && target !== document.body ? target : null;
			onOpenAutoFocus?.(event);
		},
		onCloseAutoFocus(event: Event) {
			onCloseAutoFocus?.(event);
			const target = opener.current;
			opener.current = null;
			// A caller that already chose where focus goes wins; an opener that has
			// gone (a menu item, a row that was deleted) leaves Radix's own choice.
			if (event.defaultPrevented || !target?.isConnected) return;
			event.preventDefault();
			target.focus({ preventScroll: true });
		}
	};
}
