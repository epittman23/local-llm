import { expect, it, vi } from 'vitest';

let reads = 0;
vi.mock('@/lib/apis/ollama', () => ({
	pullModel: vi.fn(async () => [new Response('x'), new AbortController()]),
	deleteModel: vi.fn(async () => true)
}));
vi.mock('@/routes/admin/settings/models/ollamaStreams', async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	// A stream that has errored (e.g. the connection dropped mid-pull): every read rejects
	// with the same TypeError, as a real errored ReadableStream does. Give up after 1000
	// reads so the test terminates; a real one never stops rejecting.
	lineReader: () => ({
		read: () => (++reads > 1000 ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(new TypeError('network error'))),
		cancel: async () => undefined
	})
}));

import { startPull } from '@/routes/admin/settings/models/ollamaDownloads';

it('startPull keeps re-reading an errored stream instead of stopping', async () => {
	let macrotaskRan = false;
	setTimeout(() => (macrotaskRan = true), 0);
	await startPull('t', 'llama3:8b', 0);
	console.log('reads =', reads, '; a setTimeout(0) got to run during the loop:', macrotaskRan);
	expect(reads).toBe(1001);
	expect(macrotaskRan).toBe(false);
});
