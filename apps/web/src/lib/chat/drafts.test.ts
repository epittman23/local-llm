import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, draftKeyFor, loadDraft, saveDraft } from './drafts';

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

describe('drafts', () => {
	it('keys a saved chat by its id, and a new one by its folder', () => {
		expect(draftKeyFor('c1', 'f1')).toBe('c1');
		expect(draftKeyFor(null, 'f1')).toBe('new:f1');
		expect(draftKeyFor(undefined)).toBe('new:');
	});

	it('keeps a draft per key, and empty text or clearDraft removes it', () => {
		saveDraft('c1', 'one');
		saveDraft('c2', 'two');
		expect([loadDraft('c1'), loadDraft('c2'), loadDraft('c3')]).toEqual(['one', 'two', '']);
		saveDraft('c1', '');
		clearDraft('c2');
		expect(sessionStorage.length).toBe(0);
	});

	it('keeps nothing, and fails nothing, when storage refuses', () => {
		vi.stubGlobal('sessionStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		});
		expect(() => saveDraft('c1', 'x')).not.toThrow();
		expect(() => clearDraft('c1')).not.toThrow();
		expect(loadDraft('c1')).toBe('');
	});
});
