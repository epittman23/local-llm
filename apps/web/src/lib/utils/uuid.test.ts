import { afterEach, describe, expect, it, vi } from 'vitest';
import { addResponses, addUserMessage, emptyHistory } from '@/lib/chat/history';
import { uuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = globalThis.crypto;

/** A crypto with no randomUUID, as on a page served over plain HTTP from the LAN (#241). */
function insecureContext() {
	const getRandomValues = vi.fn((a: Uint8Array<ArrayBuffer>) => realCrypto.getRandomValues(a));
	vi.stubGlobal('crypto', { getRandomValues });
	return getRandomValues;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('uuid', () => {
	it('uses crypto.randomUUID where it exists', () => {
		const spy = vi.spyOn(realCrypto, 'randomUUID');
		expect(uuid()).toMatch(V4);
		expect(spy).toHaveBeenCalledOnce();
		spy.mockRestore();
	});

	it('falls back to getRandomValues for a version 4 UUID without it', () => {
		const getRandomValues = insecureContext();
		const ids = Array.from({ length: 500 }, uuid);
		expect(getRandomValues).toHaveBeenCalledTimes(500);
		for (const id of ids) expect(id).toMatch(V4);
		expect(new Set(ids).size).toBe(500);
	});

	it('lets a message be sent without crypto.randomUUID', () => {
		insecureContext();
		const u = addUserMessage(emptyHistory(), null, { content: 'hi', models: ['m1'] });
		const r = addResponses(u.history, u.id, [{ id: 'm1' }]);
		expect(u.id).toMatch(V4);
		expect(r.targets[0].message_id).toMatch(V4);
		expect(r.history.messages[u.id].childrenIds).toEqual([r.targets[0].message_id]);
	});
});

describe('crypto.randomUUID', () => {
	it('is called only through uuid()', () => {
		const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
		const direct = Object.entries(sources)
			.filter(([path]) => !path.endsWith('/lib/utils/uuid.ts') && !path.includes('.test.'))
			.filter(([, text]) => /crypto\s*\.\s*randomUUID\s*\(/.test(text as string))
			.map(([path]) => path);
		expect(direct).toEqual([]);
	});
});
