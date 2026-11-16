import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerUnreachableError } from '@/lib/apis/errors';
import { textCompletion } from './index';

afterEach(() => vi.unstubAllGlobals());

describe('textCompletion (#1108)', () => {
	it('POSTs the body to /openai/completions with the bearer token, abortable by the given controller', async () => {
		const fetchMock = vi.fn(async () => new Response('data: [DONE]\n\n'));
		vi.stubGlobal('fetch', fetchMock);
		const controller = new AbortController();

		const [res, ctrl] = await textCompletion('tok', { model: 'm', prompt: 'Once' }, controller);
		expect(res?.ok).toBe(true);
		expect(ctrl).toBe(controller);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/openai/completions');
		expect(init.method).toBe('POST');
		expect(init.signal).toBe(controller.signal);
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
		expect(JSON.parse(init.body as string)).toEqual({ model: 'm', prompt: 'Once' });
	});

	it('throws a server that cannot be reached as such', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			})
		);
		await expect(textCompletion('tok', {})).rejects.toBeInstanceOf(ServerUnreachableError);
	});

	it('logs nothing when its own caller aborted it', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new DOMException('aborted', 'AbortError');
			})
		);
		await expect(textCompletion('tok', {}, controller)).rejects.toBeInstanceOf(DOMException);
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
