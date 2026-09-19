import { describe, expect, it } from 'vitest';
import {
	type AccessGrant,
	addAccess,
	dedupeAccessGrants,
	getVisibility,
	normalizeInputToGrants,
	principalIdsByPermission,
	removePrincipal,
	setVisibility,
	togglePrincipalWrite,
	togglePublicWrite
} from './accessGrants';

const g = (
	principal_type: AccessGrant['principal_type'],
	principal_id: string,
	permission: AccessGrant['permission']
): AccessGrant => ({ principal_type, principal_id, permission });

describe('normalizeInputToGrants', () => {
	it('reads legacy null as public read', () => {
		expect(normalizeInputToGrants(null)).toEqual([g('user', '*', 'read')]);
	});

	it('flattens the legacy {read, write} object, groups before users', () => {
		const grants = normalizeInputToGrants({
			read: { group_ids: ['g1'], user_ids: ['u1'] },
			write: { group_ids: [], user_ids: ['u1'] }
		});
		expect(grants).toEqual([g('group', 'g1', 'read'), g('user', 'u1', 'read'), g('user', 'u1', 'write')]);
	});

	it('treats anything else as no grants', () => {
		expect(normalizeInputToGrants(undefined)).toEqual([]);
		expect(normalizeInputToGrants('nope')).toEqual([]);
		expect(normalizeInputToGrants({})).toEqual([]);
	});
});

describe('dedupeAccessGrants', () => {
	it('drops duplicates and grants missing a field, and keeps the id of the last duplicate', () => {
		const out = dedupeAccessGrants([
			g('user', 'u1', 'read'),
			{ ...g('user', 'u1', 'read'), id: 'later' },
			{ principal_type: 'user', principal_id: '', permission: 'read' }
		]);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe('later');
	});
});

describe('visibility', () => {
	it('ranks open above public above private', () => {
		expect(getVisibility([])).toBe('private');
		expect(getVisibility([g('user', '*', 'read')])).toBe('public');
		expect(getVisibility([g('user', '*', 'read'), g('anyone', '*', 'read')])).toBe('open');
	});

	it('swaps the wildcard grant and leaves named principals alone', () => {
		const start = [g('user', 'u1', 'read'), g('user', '*', 'read'), g('user', '*', 'write')];
		expect(setVisibility(start, 'private')).toEqual([g('user', 'u1', 'read')]);
		expect(setVisibility(start, 'open')).toEqual([g('user', 'u1', 'read'), g('anyone', '*', 'read')]);
		expect(setVisibility([g('user', 'u1', 'read')], 'public')).toEqual([
			g('user', 'u1', 'read'),
			g('user', '*', 'read')
		]);
	});

	it('toggles public write on and off', () => {
		const on = togglePublicWrite([g('user', '*', 'read')]);
		expect(on).toContainEqual(g('user', '*', 'write'));
		expect(togglePublicWrite(on)).not.toContainEqual(g('user', '*', 'write'));
	});
});

describe('per-principal edits', () => {
	it('granting write also grants read; revoking write keeps read', () => {
		const granted = togglePrincipalWrite([], 'group', 'g1');
		expect(granted).toEqual([g('group', 'g1', 'read'), g('group', 'g1', 'write')]);
		expect(togglePrincipalWrite(granted, 'group', 'g1')).toEqual([g('group', 'g1', 'read')]);
	});

	it('removePrincipal drops both permissions for that principal only', () => {
		const start = [g('user', 'u1', 'read'), g('user', 'u1', 'write'), g('user', 'u2', 'read')];
		expect(removePrincipal(start, 'user', 'u1')).toEqual([g('user', 'u2', 'read')]);
	});

	it('addAccess adds read for the default read, and read+write for a default of write', () => {
		expect(addAccess([], { userIds: ['u1'], groupIds: ['g1'] }, 'read')).toEqual([
			g('group', 'g1', 'read'),
			g('user', 'u1', 'read')
		]);
		expect(addAccess([], { userIds: ['u1'], groupIds: [] }, 'write')).toEqual([
			g('user', 'u1', 'read'),
			g('user', 'u1', 'write')
		]);
	});

	it('principalIdsByPermission is distinct and type-scoped', () => {
		const grants = [g('user', 'u1', 'read'), g('user', 'u1', 'read'), g('group', 'g1', 'read')];
		expect(principalIdsByPermission(grants, 'user', 'read')).toEqual(['u1']);
		expect(principalIdsByPermission(grants, 'user', 'write')).toEqual([]);
	});
});
