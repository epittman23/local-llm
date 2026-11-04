import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStreamRunner } from './useStreamRunner';

// #207: the request's AbortController only reached the hook once the
// response's headers had arrived, so until then Stop and leaving the page
// aborted nothing, and a slow model's request ran on.

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

/** A fetch that has not answered yet: it settles only when its signal aborts. */
const pendingFetch = () => {
	const signals: AbortSignal[] = [];
	const fetch = vi.fn(
		(_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init.signal as AbortSignal;
				signals.push(signal);
				signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			})
	);
	vi.stubGlobal('fetch', fetch);
	return signals;
};

const event = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

describe('useStreamRunner (#207)', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.unstubAllGlobals());

	it('Stop aborts a request still waiting for its response, and says nothing', async () => {
		const signals = pendingFetch();
		const { result } = renderHook(() => useStreamRunner());
		let done: Promise<void> | undefined;
		act(() => {
			done = result.current.run({ model: 'm' }, vi.fn());
		});
		await waitFor(() => expect(signals).toHaveLength(1));
		expect(result.current.running).toBe(true);

		act(() => result.current.stop());
		await act(async () => {
			await done;
		});

		expect(signals[0]?.aborted).toBe(true);
		expect(result.current.running).toBe(false);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('leaving the page aborts a request still waiting for its response', async () => {
		const signals = pendingFetch();
		const { result, unmount } = renderHook(() => useStreamRunner());
		act(() => {
			void result.current.run({ model: 'm' }, vi.fn());
		});
		await waitFor(() => expect(signals).toHaveLength(1));

		unmount();

		expect(signals[0]?.aborted).toBe(true);
	});

	it('streams the reply, and a failed request still shows its error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(event('Hel') + event('lo')))
		);
		const { result } = renderHook(() => useStreamRunner());
		const text: string[] = [];
		await act(() => result.current.run({ model: 'm' }, (t) => text.push(t)));
		expect(text.join('')).toBe('Hello');

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ detail: 'Model not found' }), { status: 404 }))
		);
		await act(() => result.current.run({ model: 'nope' }, vi.fn()));
		expect(toast.error).toHaveBeenCalledWith('Model not found');
		expect(result.current.running).toBe(false);
	});

	it('a new run stops one still waiting, and Stop then reaches the new one', async () => {
		const signals = pendingFetch();
		const { result } = renderHook(() => useStreamRunner());
		act(() => {
			void result.current.run({ model: 'm' }, vi.fn());
		});
		await waitFor(() => expect(signals).toHaveLength(1));
		act(() => {
			void result.current.run({ model: 'm' }, vi.fn());
		});
		await waitFor(() => expect(signals).toHaveLength(2));
		expect(signals[0]?.aborted).toBe(true);
		// The first run's end does not end the second's running state.
		await act(async () => {});
		expect(result.current.running).toBe(true);

		act(() => result.current.stop());
		expect(signals[1]?.aborted).toBe(true);
	});

	it('a Stop before the response logs nothing', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const signals = pendingFetch();
		const { result } = renderHook(() => useStreamRunner());
		let done: Promise<void> | undefined;
		act(() => {
			done = result.current.run({ model: 'm' }, vi.fn());
		});
		await waitFor(() => expect(signals).toHaveLength(1));
		act(() => result.current.stop());
		await act(async () => {
			await done;
		});
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
