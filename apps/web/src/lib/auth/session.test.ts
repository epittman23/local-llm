import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAuth } from './session';

// One stub for the whole file: initAuth's fetch guard captures window.fetch the
// first time it runs, so each test changes what this stub does instead.
const fetch = vi.fn();
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => vi.stubGlobal('fetch', fetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
	fetch.mockReset();
	localStorage.clear();
	localStorage.setItem('token', 'saved-token');
});

const route = (sessionAnswer: () => Promise<Response>) =>
	fetch.mockImplementation(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith('/api/config')) return json({ name: 'Local LLM', features: {} });
		if (url.includes('/auths/')) return sessionAnswer();
		return json({});
	});

describe('restoring the session at startup (#240)', () => {
	it('keeps the saved token when the server cannot be reached', async () => {
		route(async () => {
			throw new TypeError('Failed to fetch');
		});
		await initAuth();
		expect(localStorage.getItem('token')).toBe('saved-token');
	});

	it('drops the saved token when the server refuses it', async () => {
		route(async () => json({ detail: 'Your session has expired or the token is invalid.' }, 401));
		await initAuth();
		expect(localStorage.getItem('token')).toBeNull();
	});
});
