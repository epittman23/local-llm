import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToastTarget, toastSafeOutside } from './toastOutside';

/** A cancelable event as it reaches the handler: `target` is where it was dispatched. */
function fire(target: Element) {
	let seen: Event | undefined;
	target.addEventListener('x', (e) => (seen = e), { once: true });
	target.dispatchEvent(new CustomEvent('x', { cancelable: true }));
	return seen as Event;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('toastSafeOutside', () => {
	const setup = () => {
		document.body.innerHTML =
			'<ol data-sonner-toaster><li><button id="undo">Undo</button></li></ol><div id="page"></div>';
		return { undo: document.getElementById('undo') as Element, page: document.getElementById('page') as Element };
	};

	it('recognises a target inside the toaster', () => {
		const { undo, page } = setup();
		expect(isToastTarget(fire(undo))).toBe(true);
		expect(isToastTarget(fire(page))).toBe(false);
	});

	it('prevents the close for a toast target and skips the caller handlers', () => {
		const { undo } = setup();
		const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
		const handlers = toastSafeOutside(a, b, c);
		for (const handle of Object.values(handlers)) {
			const event = fire(undo);
			handle(event);
			expect(event.defaultPrevented).toBe(true);
		}
		expect(a).not.toHaveBeenCalled();
		expect(b).not.toHaveBeenCalled();
		expect(c).not.toHaveBeenCalled();
	});

	it('leaves other targets alone and still calls the caller handlers', () => {
		const { page } = setup();
		const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
		const handlers = toastSafeOutside(a, b, c);
		const event = fire(page);
		handlers.onPointerDownOutside(event);
		handlers.onInteractOutside(event);
		handlers.onFocusOutside(event);
		expect(event.defaultPrevented).toBe(false);
		expect(a).toHaveBeenCalledWith(event);
		expect(b).toHaveBeenCalledWith(event);
		expect(c).toHaveBeenCalledWith(event);
	});

	it('works with no caller handlers', () => {
		const { page } = setup();
		const handlers = toastSafeOutside(undefined, undefined, undefined);
		const event = fire(page);
		expect(() => handlers.onInteractOutside(event)).not.toThrow();
		expect(event.defaultPrevented).toBe(false);
	});
});
