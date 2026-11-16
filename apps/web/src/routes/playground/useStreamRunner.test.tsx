import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunResult, speed, useStreamRunner } from './useStreamRunner';

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
		let done: Promise<unknown> | undefined;
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

	it("streams the reply, and returns a failed request's error for the page to show in place (#968)", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(event('Hel') + event('lo')))
		);
		const { result } = renderHook(() => useStreamRunner());
		const text: string[] = [];
		let outcome: RunResult | undefined;
		await act(async () => {
			outcome = await result.current.run({ model: 'm' }, (t) => text.push(t));
		});
		expect(text.join('')).toBe('Hello');
		expect(outcome?.error).toBeNull();
		expect(outcome?.stats.ttftMs).toBeGreaterThanOrEqual(0);

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ detail: 'Model not found' }), { status: 404 }))
		);
		await act(async () => {
			outcome = await result.current.run({ model: 'nope' }, vi.fn());
		});
		expect(outcome).toEqual({ error: 'Model not found', stats: {} });
		expect(toast.error).not.toHaveBeenCalled();
		expect(result.current.running).toBe(false);
	});

	it('reports the tokens a provider sends in its usage chunk (D8)', async () => {
		const usage = `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 12 } })}\n`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(event('Hi') + usage))
		);
		const { result } = renderHook(() => useStreamRunner());
		let outcome: RunResult | undefined;
		await act(async () => {
			outcome = await result.current.run({ model: 'm' }, vi.fn());
		});
		expect(outcome?.stats.tokens).toBe(12);
	});

	it('sends through the request it is given: a text completion for the Completions tab', async () => {
		const send = vi.fn(
			async (_t: string, _b: object, c: AbortController) => [new Response(event('x')), c] as [Response, AbortController]
		);
		const { result } = renderHook(() => useStreamRunner(send));
		await act(async () => {
			await result.current.run({ model: 'm', prompt: 'p' }, vi.fn());
		});
		expect(send).toHaveBeenCalledWith('', { model: 'm', prompt: 'p' }, expect.any(AbortController));
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
		let done: Promise<unknown> | undefined;
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

describe('speed (D8)', () => {
	it('is nothing until a first token arrived', () => {
		expect(speed(0, undefined, 500)).toEqual({});
	});
	it('is the time to the first token, then tokens over the time after it when usage was reported', () => {
		expect(speed(100, 600, 600)).toEqual({ ttftMs: 500 });
		expect(speed(100, 600, 2600, { completion_tokens: 50 })).toEqual({ ttftMs: 500, tokens: 50, tokensPerSecond: 25 });
		// A reply that came in one piece, or nearly, has a count but no rate.
		expect(speed(100, 600, 600, { completion_tokens: 3 })).toEqual({ ttftMs: 500, tokens: 3 });
		expect(speed(100, 600, 690, { completion_tokens: 3 })).toEqual({ ttftMs: 500, tokens: 3 });
	});
});
