import { describe, expect, it } from 'vitest';
import { initials } from './initials';

describe('initials', () => {
	it('takes the first letters of the first and last words', () => {
		expect(initials('Ada Lovelace')).toBe('AL');
		expect(initials('Ada King Lovelace')).toBe('AL');
	});

	it('takes one letter from a one-word name, upper-cased', () => {
		expect(initials('qwen3-coder')).toBe('Q');
	});

	it('tells model ids with a provider apart by the word parts after the last slash (#990)', () => {
		expect(initials('qwen/qwen-2.5-coder-32b-instruct')).toBe('QC');
		expect(initials('qwen/qwen3.6-27b')).toBe('QB');
		expect(initials('meta-llama/llama_3.1_70b')).toBe('LB');
		expect(initials('org/deep/mistral')).toBe('M');
	});

	it('falls back to the whole id when nothing after the slash has a letter', () => {
		expect(initials('org/123')).toBe('O');
		expect(initials('org/')).toBe('O');
	});

	it('keeps a name with spaces as first and last word, slash or not', () => {
		expect(initials('AC/DC Fan Club')).toBe('AC');
		expect(initials('Ada Lovelace')).toBe('AL');
	});

	it('ignores surrounding and repeated spaces', () => {
		expect(initials('  grace   hopper ')).toBe('GH');
	});

	it('keeps a letter outside the basic plane whole', () => {
		expect(initials('𝒜da Byron')).toBe('𝒜B');
	});

	it('shows a question mark for a blank or missing name', () => {
		expect(initials('')).toBe('?');
		expect(initials('   ')).toBe('?');
		expect(initials(undefined)).toBe('?');
		expect(initials(null)).toBe('?');
	});
});
