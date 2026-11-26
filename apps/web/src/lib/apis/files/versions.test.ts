// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerUnreachableError } from '@/lib/apis/errors';
import { createFileVersion, listFileVersions } from './versions';

const stubFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
	const fetch = vi.fn(async (url: string, init?: RequestInit) => respond(url, init));
	vi.stubGlobal('fetch', fetch);
	return fetch;
};

afterEach(() => vi.unstubAllGlobals());

describe('listFileVersions', () => {
	it('asks the versions route with the token and returns the list as sent', async () => {
		const list = [
			{ id: 'a', version: 1, size: 3, created_at: 10, name: 'n.md' },
			{ id: 'b', version: 2, size: 4, created_at: 20, name: 'n.md' }
		];
		const fetch = stubFetch(() => Response.json(list));
		expect(await listFileVersions('tok', 'a/b')).toEqual(list);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/files/a%2Fb/versions');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
	});
	it('throws the refusal body, a body that is no list, and an unreachable server', async () => {
		stubFetch(() => Response.json({ detail: 'Not found' }, { status: 404 }));
		await expect(listFileVersions('t', 'x')).rejects.toEqual({ detail: 'Not found' });
		stubFetch(() => Response.json({}));
		await expect(listFileVersions('t', 'x')).rejects.toThrow('The server sent no version list');
		stubFetch(() => Promise.reject(new TypeError('failed')));
		await expect(listFileVersions('t', 'x')).rejects.toBeInstanceOf(ServerUnreachableError);
	});
});

describe('createFileVersion', () => {
	it('posts the content as JSON and returns the saved file', async () => {
		const fetch = stubFetch(() => Response.json({ id: 'v2', meta: { version: 2 }, data: {} }));
		expect(await createFileVersion('tok', 'a', 'line 1\r\nline 2')).toMatchObject({ id: 'v2', meta: { version: 2 } });
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/files/a/versions');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({ content: 'line 1\r\nline 2' });
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
	});
	it('throws the refusal body (an empty or oversize text, a stranger), a reply without a file, and an unreachable server', async () => {
		stubFetch(() => Response.json({ detail: 'A file cannot be saved empty' }, { status: 400 }));
		await expect(createFileVersion('t', 'x', '')).rejects.toEqual({ detail: 'A file cannot be saved empty' });
		stubFetch(() => Response.json({}));
		await expect(createFileVersion('t', 'x', 'a')).rejects.toThrow('The server sent no version');
		stubFetch(() => Promise.reject(new TypeError('failed')));
		await expect(createFileVersion('t', 'x', 'a')).rejects.toBeInstanceOf(ServerUnreachableError);
	});
});
