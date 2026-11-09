import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinChannelById } from './index';

afterEach(() => vi.unstubAllGlobals());

describe('joinChannelById', () => {
	it('POSTs to the channel join route with the bearer token and returns the body', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'c1' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await joinChannelById('tok', 'c1')).toEqual({ id: 'c1' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/\/channels\/c1\/join$/);
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
	});

	it('throws the server detail when the join is refused', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ detail: 'Not a public channel' }), { status: 403 }))
		);
		await expect(joinChannelById('tok', 'c1')).rejects.toBe('Not a public channel');
	});
});
