import { describe, expect, it } from 'vitest';
import { configuredParams, isPubliclyReadable, mergeModelOptions, normalizeModelSelection } from './interfaceTasks';

const pub = { principal_type: 'user', principal_id: '*', permission: 'read' };
const priv = { principal_type: 'user', principal_id: 'u1', permission: 'read' };

describe('configuredParams', () => {
	it('drops null, empty and undefined, but keeps 0 and false', () => {
		expect(configuredParams({ a: null, b: '', c: undefined, d: 0, e: false, f: 'x' })).toEqual({ d: 0, e: false, f: 'x' });
		expect(configuredParams()).toEqual({});
	});
});

describe('isPubliclyReadable', () => {
	it('is true with no grant info, or a wildcard read grant; false otherwise', () => {
		expect(isPubliclyReadable({})).toBe(true);
		expect(isPubliclyReadable({ access_grants: [priv, pub] })).toBe(true);
		expect(isPubliclyReadable({ access_grants: [priv] })).toBe(false);
		expect(isPubliclyReadable({ access_grants: [] })).toBe(false);
		expect(isPubliclyReadable({ access_grants: [{ ...pub, permission: 'write' }] })).toBe(false);
	});
});

describe('normalizeModelSelection', () => {
	const options = [
		{ id: 'a', name: 'A' },
		{ id: 'b', name: 'B', access_grants: [priv] }
	];
	it('keeps a known model, clears an unknown or empty one', () => {
		expect(normalizeModelSelection('a', options)).toEqual({ value: 'a', warn: false });
		expect(normalizeModelSelection('zzz', options)).toEqual({ value: '', warn: false });
		expect(normalizeModelSelection('', options)).toEqual({ value: '', warn: false });
		expect(normalizeModelSelection(null, options)).toEqual({ value: '', warn: false });
	});
	it('warns, but still keeps, a model that is not public', () => {
		expect(normalizeModelSelection('b', options)).toEqual({ value: 'b', warn: true });
	});
});

describe('mergeModelOptions', () => {
	it('overlays the workspace record and leaves other models as they are', () => {
		const merged = mergeModelOptions(
			[
				{ id: 'a', name: 'A', connection_type: 'local' },
				{ id: 'b', name: 'B' }
			],
			[{ id: 'a', name: 'A (custom)', access_grants: [priv] }]
		);
		expect(merged[0]).toEqual({ id: 'a', name: 'A (custom)', connection_type: 'local', access_grants: [priv] });
		expect(merged[1]).toEqual({ id: 'b', name: 'B' });
	});
});
