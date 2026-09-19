import { describe, expect, it } from 'vitest';
import { compareVersion, extractFrontmatter, nameToId } from './plugins';

describe('extractFrontmatter', () => {
	it('reads the docstring header and stops at the closing quotes', () => {
		const fm = extractFrontmatter('"""\ntitle: My Tool\ndescription: Does: things\nrequired_open_webui_version: 0.5.0\n"""\nimport os\nnot_a: header');
		expect(fm).toMatchObject({ title: 'My Tool', description: 'Does: things', required_open_webui_version: '0.5.0' });
		expect(fm.not_a).toBeUndefined();
	});

	it('returns nothing unless the file opens with a bare """', () => {
		expect(Object.keys(extractFrontmatter('import os\n"""\ntitle: x\n"""'))).toEqual([]);
		expect(Object.keys(extractFrontmatter(''))).toEqual([]);
	});

	it('cannot be poisoned through a __proto__ key', () => {
		expect(Object.getPrototypeOf(extractFrontmatter('"""\n"""'))).toBeNull();
	});
});

describe('compareVersion', () => {
	it('is true when the running version is older than required', () => {
		expect(compareVersion('0.6.0', '0.5.9')).toBe(true);
		expect(compareVersion('0.5.10', '0.5.9')).toBe(true);
		expect(compareVersion('0.5.0', '0.5.0')).toBe(false);
		expect(compareVersion('0.5.0', '0.6.0')).toBe(false);
	});
	it('never blocks on an unknown (0.0.0) build', () => {
		expect(compareVersion('9.9.9', '0.0.0')).toBe(false);
	});
});

describe('nameToId', () => {
	it('strips accents and emoji and joins words with underscores', () => {
		expect(nameToId('My Tool 😄')).toBe('my_tool');
		expect(nameToId('Café  Lookup!')).toBe('cafe_lookup');
	});
});
