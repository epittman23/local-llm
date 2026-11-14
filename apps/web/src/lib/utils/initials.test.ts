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
