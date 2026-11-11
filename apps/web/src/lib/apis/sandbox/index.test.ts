// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerUnreachableError } from '@/lib/apis/errors';
import { getSandboxOutputHtml, getSandboxOutputText } from './index';

const stubFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
	const fetch = vi.fn(async (url: string, init?: RequestInit) => respond(url, init));
	vi.stubGlobal('fetch', fetch);
	return fetch;
};

/** A body streamed in the given chunks, recording whether the reader cancelled it. */
function chunked(chunks: Uint8Array[]) {
	const state = { pulled: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++]);
			else controller.close();
		},
		cancel() {
			state.cancelled = true;
		}
	});
	return { body, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('getSandboxOutputHtml', () => {
	it('asks the outputs route with the token and returns the document', async () => {
		const fetch = stubFetch(() => Response.json({ html: '<p>x</p>' }));
		expect(await getSandboxOutputHtml('tok', 'a/b')).toBe('<p>x</p>');
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/sandbox/outputs/a%2Fb/html');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
	});
	it('throws the refusal body, a body without a document, and an unreachable server', async () => {
		stubFetch(() => Response.json({ detail: 'too big' }, { status: 413 }));
		await expect(getSandboxOutputHtml('t', 'x')).rejects.toEqual({ detail: 'too big' });
		stubFetch(() => Response.json({}));
		await expect(getSandboxOutputHtml('t', 'x')).rejects.toThrow('The server sent no document');
		stubFetch(() => Promise.reject(new TypeError('failed')));
		await expect(getSandboxOutputHtml('t', 'x')).rejects.toBeInstanceOf(ServerUnreachableError);
	});
});

describe('getSandboxOutputText', () => {
	const enc = new TextEncoder();

	it('reads a file under the cap whole', async () => {
		const fetch = stubFetch(() => new Response('print(1)\n'));
		expect(await getSandboxOutputText('tok', 'f', 100)).toEqual({ text: 'print(1)\n', truncated: false });
		expect(fetch.mock.calls[0][0]).toBe('/api/v1/files/f/content');
	});
	it('stops reading at the cap, cancels the rest, and never shows half a character', async () => {
		// "é" is two bytes, and a cap of 4 cuts it in half.
		const { body, state } = chunked([enc.encode('abcé'), enc.encode('more'), enc.encode('never read')]);
		stubFetch(() => new Response(body));
		expect(await getSandboxOutputText('t', 'f', 4)).toEqual({ text: 'abc', truncated: true });
		expect(state.cancelled).toBe(true);
		// The stream may buffer one chunk ahead, never the rest.
		expect(state.pulled).toBeLessThan(3);
		const exact = chunked([enc.encode('abcd'), enc.encode('e')]);
		stubFetch(() => new Response(exact.body));
		expect(await getSandboxOutputText('t', 'f', 4)).toEqual({ text: 'abcd', truncated: true });
	});
	it('passes the signal on, and stops reading and cancels the body when it aborts', async () => {
		const abort = new AbortController();
		const { body, state } = chunked([enc.encode('ab'), enc.encode('cd'), enc.encode('ef'), enc.encode('gh')]);
		// A fetch that ignores the signal, so the read loop's own check is what stops it.
		const fetch = stubFetch(() => new Response(body));
		const reading = getSandboxOutputText('t', 'f', 100, abort.signal);
		abort.abort();
		await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
		expect(state.cancelled).toBe(true);
		expect(fetch.mock.calls[0][1]?.signal).toBe(abort.signal);
		const htmlFetch = stubFetch(() => Response.json({ html: 'x' }));
		await getSandboxOutputHtml('t', 'f', abort.signal);
		expect(htmlFetch.mock.calls[0][1]?.signal).toBe(abort.signal);
	});
	it('reads a response without a stream from its buffer', async () => {
		const response = new Response('abcdef');
		Object.defineProperty(response, 'body', { value: null });
		stubFetch(() => response);
		expect(await getSandboxOutputText('t', 'f', 3)).toEqual({ text: 'abc', truncated: true });
	});
	it('throws a refusal body and an unreachable server', async () => {
		stubFetch(() => Response.json({ detail: 'Not found' }, { status: 404 }));
		await expect(getSandboxOutputText('t', 'f', 3)).rejects.toEqual({ detail: 'Not found' });
		stubFetch(() => Promise.reject(new TypeError('failed')));
		await expect(getSandboxOutputText('t', 'f', 3)).rejects.toBeInstanceOf(ServerUnreachableError);
	});
});
