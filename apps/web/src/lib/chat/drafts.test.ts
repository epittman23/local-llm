import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, draftKeyFor, forgetOtherUsersDrafts, loadDraft, saveDraft } from './drafts';

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

describe('drafts', () => {
	it('keys a saved chat by its account and id, and a new one by its folder', () => {
		expect(draftKeyFor('u1', 'c1', 'f1')).toBe('u1:c1');
		expect(draftKeyFor('u1', null, 'f1')).toBe('u1:new:f1');
		expect(draftKeyFor('u1', undefined)).toBe('u1:new:');
		expect(draftKeyFor('u2', 'c1')).not.toBe(draftKeyFor('u1', 'c1'));
	});

	it("forgets other accounts' drafts and keeps this account's and anything else", () => {
		saveDraft(draftKeyFor('u1', 'c1'), 'mine');
		saveDraft(draftKeyFor('u10', 'c1'), 'a look-alike id');
		saveDraft(draftKeyFor('u2', 'c1'), 'theirs');
		sessionStorage.setItem('other', 'x');
		forgetOtherUsersDrafts('u1');
		expect(loadDraft(draftKeyFor('u1', 'c1'))).toBe('mine');
		expect(loadDraft(draftKeyFor('u10', 'c1'))).toBe('');
		expect(loadDraft(draftKeyFor('u2', 'c1'))).toBe('');
		expect(sessionStorage.getItem('other')).toBe('x');
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
		expect(() => forgetOtherUsersDrafts('u1')).not.toThrow();
	});
});
