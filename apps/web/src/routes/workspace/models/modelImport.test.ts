import { describe, expect, it } from 'vitest';
import { modelSharePayload, parseModelImport, sanitizeIncomingModel } from './modelImport';

const grants = [{ principal_type: 'user', principal_id: '*', permission: 'write' }];

describe('sanitizeIncomingModel', () => {
	it("unwraps the community site's {info} wrapper and needs an id and a name", () => {
		expect(sanitizeIncomingModel({ info: { id: 'm', name: 'M' } }, { withGrants: false })).toMatchObject({ id: 'm', name: 'M', meta: {}, params: {} });
		expect(sanitizeIncomingModel({ id: 'm' }, { withGrants: false })).toBeNull();
		expect(sanitizeIncomingModel('x', { withGrants: false })).toBeNull();
		expect(sanitizeIncomingModel([1], { withGrants: false })).toBeNull();
	});
	it('only keeps a clone\'s well-formed grants; nothing from outside ever brings any', () => {
		const raw = { id: 'm', name: 'M', access_grants: [...grants, { principal_type: 'user' }] };
		expect(sanitizeIncomingModel(raw, { withGrants: false })?.access_grants).toEqual([]);
		expect(sanitizeIncomingModel(raw, { withGrants: true })?.access_grants).toHaveLength(1);
	});
	it('drops unknown top-level fields and deep-copies meta and params', () => {
		const meta = { tags: [{ name: 'x' }] };
		const out = sanitizeIncomingModel({ id: 'm', name: 'M', user_id: 'attacker', is_active: false, meta }, { withGrants: false });
		expect(out).not.toHaveProperty('user_id');
		expect(out).not.toHaveProperty('is_active');
		out!.meta.tags.push({ name: 'y' });
		expect(meta.tags).toHaveLength(1);
	});
});

describe('parseModelImport', () => {
	it('requires an array, accepts both shapes, skips unusable entries and drops grants', () => {
		const out = parseModelImport(JSON.stringify([{ id: 'a', name: 'A', access_grants: grants }, { info: { id: 'b', name: 'B' }, id: 'b' }, { id: 'c' }, 7]));
		expect(out.map((m) => m.id)).toEqual(['a', 'b']);
		expect(out[0].access_grants).toEqual([]);
		expect(() => parseModelImport('{}')).toThrow(/array/);
	});
});

describe('modelSharePayload', () => {
	it('omits the author and grants', () => {
		const p = modelSharePayload({ id: 'm', name: 'M', user: { email: 'a@b.c' }, access_grants: grants, meta: { d: 1 } });
		expect(JSON.stringify(p)).not.toContain('a@b.c');
		expect(p).toEqual({ id: 'm', name: 'M', base_model_id: null, meta: { d: 1 }, params: {} });
	});
});
