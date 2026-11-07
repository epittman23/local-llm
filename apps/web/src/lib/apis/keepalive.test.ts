import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateChatById } from './chats';
import { KEEPALIVE_QUOTA, keepaliveInit } from './keepalive';
import { updateKnowledgeById } from './knowledge';
import { updateNoteById } from './notes';
import { updatePromptMetadata } from './prompts';

describe('keepaliveInit (#675)', () => {
	it('asks for keepalive only for a save sent as the page goes away', () => {
		expect(keepaliveInit('{}', true)).toEqual({ keepalive: true });
		expect(keepaliveInit('{}', false)).toEqual({});
	});

	it('leaves it off a body past the quota, counted in bytes, not characters', () => {
		expect(keepaliveInit('a'.repeat(KEEPALIVE_QUOTA), true)).toEqual({ keepalive: true });
		expect(keepaliveInit('a'.repeat(KEEPALIVE_QUOTA + 1), true)).toEqual({});
		// Two bytes each in UTF-8: half the quota in characters fills it.
		expect(keepaliveInit('é'.repeat(KEEPALIVE_QUOTA / 2), true)).toEqual({ keepalive: true });
		expect(keepaliveInit(`${'é'.repeat(KEEPALIVE_QUOTA / 2)}a`, true)).toEqual({});
	});
});

describe('autosaves sent as the page goes away (#675)', () => {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
	beforeEach(() => vi.stubGlobal('fetch', fetchMock));
	afterEach(() => {
		vi.unstubAllGlobals();
		fetchMock.mockClear();
	});

	const saves: [string, (keepalive: boolean) => Promise<unknown>][] = [
		['a chat', (k) => updateChatById('t', 'c1', { params: {} }, null, k)],
		['a knowledge base', (k) => updateKnowledgeById('t', 'kb1', { name: 'KB', description: 'd' }, k)],
		['a note', (k) => updateNoteById('t', 'n1', { title: 'T', data: {} }, k)],
		['a prompt', (k) => updatePromptMetadata('t', 'p1', 'P', 'p', [], k)]
	];

	it.each(saves)('sends %s with keepalive then, and without it otherwise', async (_name, save) => {
		await save(true);
		await save(false);
		expect(fetchMock.mock.calls.map(([, init]) => init.keepalive)).toEqual([true, undefined]);
	});

	it('still sends a note too large for keepalive', async () => {
		await updateNoteById('t', 'n1', { title: 'T', data: { content: { md: 'a'.repeat(KEEPALIVE_QUOTA) } } }, true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1].keepalive).toBeUndefined();
	});
});
