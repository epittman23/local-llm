import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerUnreachableError } from '../errors';
import { getAPIKey } from './index';

// #526: only a 404 means "no key"; any other failure must reach the caller.

const answer = (status: number, body: unknown) =>
	vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValueOnce(
			new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
		);

describe('getAPIKey', () => {
	afterEach(() => vi.restoreAllMocks());

	it('gives the key', async () => {
		answer(200, { api_key: 'sk-1' });
		await expect(getAPIKey('t')).resolves.toBe('sk-1');
	});

	it('gives null when the user has no key (a 404)', async () => {
		answer(404, { detail: 'API key not found' });
		await expect(getAPIKey('t')).resolves.toBeNull();
	});

	it('throws when the server cannot be reached', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
		await expect(getAPIKey('t')).rejects.toBeInstanceOf(ServerUnreachableError);
	});

	it('throws on any other failure', async () => {
		answer(500, { detail: 'Internal Server Error' });
		await expect(getAPIKey('t')).rejects.toBe('Internal Server Error');
	});
});
