// FBK-1, FBK-2: the toaster sits outside a modal's DOM, so pressing a toast's
// button counts as an interaction outside the dialog and would close it. These
// handlers, for the content of a Dialog, AlertDialog or Sheet, ignore an
// outside interaction that lands in the toaster and pass every other one to
// the caller's own handler.

type OutsideHandler<E extends Event> = ((event: E) => void) | undefined;

const TOASTER = '[data-sonner-toaster]';

/** Whether the event's target is inside the toaster. */
export function isToastTarget(event: Event) {
	const target = event.target;
	return target instanceof Element && target.closest(TOASTER) !== null;
}

/** `handler`, skipped (and the event prevented) for a target in the toaster. */
function ignoringToasts<E extends Event>(handler: OutsideHandler<E>) {
	return (event: E) => {
		if (isToastTarget(event)) {
			event.preventDefault();
			return;
		}
		handler?.(event);
	};
}

/** The three outside-interaction handlers for a modal's Content, wrapping the caller's own. */
export function toastSafeOutside<P extends Event, I extends Event, F extends Event>(
	onPointerDownOutside: OutsideHandler<P>,
	onInteractOutside: OutsideHandler<I>,
	onFocusOutside: OutsideHandler<F>
) {
	return {
		onPointerDownOutside: ignoringToasts(onPointerDownOutside),
		onInteractOutside: ignoringToasts(onInteractOutside),
		onFocusOutside: ignoringToasts(onFocusOutside)
	};
}
