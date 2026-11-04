// A send made before the page can send waits in the box, then goes (#373).
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHeldSend } from './useHeldSend';

describe('useHeldSend (#373)', () => {
	it('sends at once when the page can send', () => {
		const send = vi.fn(() => true);
		const sent = vi.fn();
		const { result } = renderHook(() => useHeldSend(true, send, sent));

		expect(result.current('hi', [])).toBe(true);
		expect(send).toHaveBeenCalledWith('hi', []);
		expect(sent).not.toHaveBeenCalled(); // the box clears itself on true
	});

	it('holds a send, leaving it in the box, and sends it once ready', () => {
		const send = vi.fn(() => true);
		const sent = vi.fn();
		let ready = false;
		const { result, rerender } = renderHook(() => useHeldSend(ready, send, sent));

		let kept: boolean | undefined;
		act(() => {
			kept = result.current('typed early', []);
		});
		expect(kept).toBe(false);
		expect(send).not.toHaveBeenCalled();

		ready = true;
		rerender();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith('typed early', []);
		expect(sent).toHaveBeenCalledTimes(1);
		rerender();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('leaves the box as it is when the held send does not go', () => {
		const send = vi.fn(() => false);
		const sent = vi.fn();
		let ready = false;
		const { result, rerender } = renderHook(() => useHeldSend(ready, send, sent));
		act(() => {
			result.current('needs confirming', []);
		});

		ready = true;
		rerender();
		expect(send).toHaveBeenCalledTimes(1);
		expect(sent).not.toHaveBeenCalled();
	});
});
