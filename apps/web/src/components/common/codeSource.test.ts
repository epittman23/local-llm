import { describe, expect, it } from 'vitest';
import { acknowledgement, readCodeSource } from './codeSource';

describe('codeSource (S4-D4, #1098)', () => {
	it('reads a stash’s source, and nothing it does not recognise', () => {
		expect(readCodeSource({ source: { kind: 'link', from: ' https://example.com/t.py ' } })).toEqual({
			kind: 'link',
			from: 'https://example.com/t.py'
		});
		expect(readCodeSource({ source: { kind: 'clone', from: '' } })).toBeNull();
		expect(readCodeSource({ source: { kind: 'other', from: 'x' } })).toBeNull();
		expect(readCodeSource({ source: 'link' })).toBeNull();
		expect(readCodeSource({})).toBeNull();
		expect(readCodeSource(null)).toBeNull();
	});

	it('names the source in one sentence', () => {
		expect(acknowledgement('tool', { kind: 'clone', from: 'Unit converter' })).toBe(
			'The code is copied from "Unit converter", and tools run their code on this server: create it only if you trust that code.'
		);
		expect(acknowledgement('function', { kind: 'link', from: 'https://example.com/f.py' })).toBe(
			'The code comes from https://example.com/f.py, and functions run their code on this server: create it only if you trust that source.'
		);
		expect(acknowledgement('tool', { kind: 'file', from: 'tools.json' }, 'import')).toBe(
			'The code comes from the file tools.json, and tools run their code on this server: import it only if you trust that source.'
		);
		expect(acknowledgement('tool', null)).toBe(
			'The code was not written here, and tools run their code on this server: create it only if you trust its source.'
		);
	});
});
