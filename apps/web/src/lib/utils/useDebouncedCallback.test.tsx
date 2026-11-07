import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedCallback } from './useDebouncedCallback';

describe('useDebouncedCallback', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('calls once, with the last argument, after the pause', () => {
		const fn = vi.fn();
		const { result } = renderHook(() => useDebouncedCallback(fn, 500));
		act(() => {
			result.current('a');
			result.current('b');
		});
		expect(fn).not.toHaveBeenCalled();
		act(() => void vi.advanceTimersByTime(500));
		expect(fn).toHaveBeenCalledExactlyOnceWith('b', false);
	});

	it('flush makes the pending call at once and leaves nothing to call later (#525)', () => {
		const fn = vi.fn();
		const { result } = renderHook(() => useDebouncedCallback(fn, 500));
		act(() => result.current('a'));
		act(() => result.current.flush());
		expect(fn).toHaveBeenCalledExactlyOnceWith('a', false);
		act(() => void vi.advanceTimersByTime(500));
		act(() => result.current.flush());
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('keeps the same schedule function across renders', () => {
		const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, 500), {
			initialProps: { fn: vi.fn() }
		});
		const first = result.current;
		rerender({ fn: vi.fn() });
		expect(result.current).toBe(first);
	});

	it('makes a pending call on unmount, with the latest function', () => {
		const first = vi.fn();
		const latest = vi.fn();
		const { result, rerender, unmount } = renderHook(({ fn }) => useDebouncedCallback(fn, 500), {
			initialProps: { fn: first }
		});
		act(() => result.current('a'));
		rerender({ fn: latest });
		unmount();
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledExactlyOnceWith('a', false);
	});

	it('makes a pending call as the page goes away, saying so, and only once (#675)', () => {
		const fn = vi.fn();
		const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 500));
		act(() => result.current('a'));
		act(() => void window.dispatchEvent(new Event('pagehide')));
		expect(fn).toHaveBeenCalledExactlyOnceWith('a', true);
		act(() => void vi.advanceTimersByTime(500));
		unmount();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('makes no call as the page goes away when nothing is pending, nor once unmounted', () => {
		const fn = vi.fn();
		const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 500));
		act(() => void window.dispatchEvent(new Event('pagehide')));
		act(() => result.current('a'));
		act(() => void vi.advanceTimersByTime(500));
		unmount();
		window.dispatchEvent(new Event('pagehide'));
		expect(fn).toHaveBeenCalledExactlyOnceWith('a', false);
	});
});
