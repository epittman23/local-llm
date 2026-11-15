// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_MS, useCopy } from './useCopy';

const { toastError, copyToClipboard } = vi.hoisted(() => ({ toastError: vi.fn(), copyToClipboard: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/utils', () => ({ copyToClipboard }));

describe('useCopy', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('says "copied" for 1.5 s after a successful copy', async () => {
		copyToClipboard.mockResolvedValue(true);
		const { result } = renderHook(() => useCopy());
		expect(result.current.copied).toBe(false);
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.copy('hello', 'table');
		});
		expect(ok).toBe(true);
		expect(copyToClipboard).toHaveBeenCalledWith('hello');
		expect(result.current.copied).toBe(true);
		expect(toastError).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(COPIED_MS - 1));
		expect(result.current.copied).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.copied).toBe(false);
	});

	it('restarts the 1.5 s when copied again', async () => {
		copyToClipboard.mockResolvedValue(true);
		const { result } = renderHook(() => useCopy());
		await act(async () => void (await result.current.copy('a')));
		act(() => vi.advanceTimersByTime(1000));
		await act(async () => void (await result.current.copy('b')));
		act(() => vi.advanceTimersByTime(1000));
		expect(result.current.copied).toBe(true);
		act(() => vi.advanceTimersByTime(500));
		expect(result.current.copied).toBe(false);
	});

	it('reports a refused write in a toast naming the thing, and returns false', async () => {
		copyToClipboard.mockResolvedValue(false);
		const { result } = renderHook(() => useCopy());
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.copy('x', 'code');
		});
		expect(ok).toBe(false);
		expect(result.current.copied).toBe(false);
		expect(toastError).toHaveBeenCalledWith("Couldn't copy the code: the browser blocked clipboard access");
	});

	it('words the toast without a name when none is given', async () => {
		copyToClipboard.mockResolvedValue(false);
		const { result } = renderHook(() => useCopy());
		await act(async () => void (await result.current.copy('x')));
		expect(toastError).toHaveBeenCalledWith("Couldn't copy: the browser blocked clipboard access");
	});

	it('leaves no timer running after unmount', async () => {
		copyToClipboard.mockResolvedValue(true);
		const { result, unmount } = renderHook(() => useCopy());
		await act(async () => void (await result.current.copy('a')));
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
