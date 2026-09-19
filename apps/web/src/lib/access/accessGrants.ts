// The pure half of workspace/common/AccessControl.svelte: how a list of access
// grants is normalised, and how each UI action (change visibility, add a
// principal, toggle write) rewrites it. Pulled out of the component -- where
// the Svelte version keeps it as ~250 lines of closures over reactive
// variables -- so it can be unit-tested without rendering anything, and so the
// React component is left with only state and layout.
//
// Not ported: the two-way `accessControl` binding (the legacy
// {read: {group_ids, user_ids}, write: ...} shape). No caller in the SvelteKit
// app binds it -- checked with a grep for `bind:accessControl` -- so it was dead
// on arrival. `normalizeInputToGrants` still *accepts* the legacy shape as
// input, because an item written before grants existed can still carry it.

export type Principal = 'user' | 'group' | 'anyone';
export type Permission = 'read' | 'write';

export type AccessGrant = {
	id?: string;
	principal_type: Principal;
	principal_id: string;
	permission: Permission;
};

export type Visibility = 'private' | 'public' | 'open';

type LegacyAccessControl = {
	read?: { group_ids?: string[]; user_ids?: string[] };
	write?: { group_ids?: string[]; user_ids?: string[] };
};

/** `*` as a principal id means "everyone" (`user:*`) or "anyone with the link" (`anyone:*`). */
const WILDCARD = '*';

export function dedupeAccessGrants(grants: AccessGrant[] | null | undefined): AccessGrant[] {
	if (!Array.isArray(grants)) return [];
	const byKey = new Map<string, AccessGrant>();
	for (const grant of grants) {
		if (!grant?.principal_type || !grant.principal_id || !grant.permission) continue;
		byKey.set(`${grant.principal_type}:${grant.principal_id}:${grant.permission}`, {
			id: grant.id,
			principal_type: grant.principal_type,
			principal_id: grant.principal_id,
			permission: grant.permission
		});
	}
	return Array.from(byKey.values());
}

/** Legacy `null` meant "public read"; the object form listed ids per permission. */
export function legacyAccessControlToGrants(legacy: LegacyAccessControl | null): AccessGrant[] {
	if (legacy === null) {
		return [{ principal_type: 'user', principal_id: WILDCARD, permission: 'read' }];
	}
	if (typeof legacy !== 'object') return [];

	const grants: AccessGrant[] = [];
	for (const permission of ['read', 'write'] as const) {
		const entry = legacy[permission] ?? {};
		for (const groupId of entry.group_ids ?? []) {
			grants.push({ principal_type: 'group', principal_id: groupId, permission });
		}
		for (const userId of entry.user_ids ?? []) {
			grants.push({ principal_type: 'user', principal_id: userId, permission });
		}
	}
	return dedupeAccessGrants(grants);
}

/** Accepts null (legacy public), a grants array, or the legacy object. Anything else is "no grants". */
export function normalizeInputToGrants(value: unknown): AccessGrant[] {
	if (value === null) return legacyAccessControlToGrants(null);
	if (Array.isArray(value)) return dedupeAccessGrants(value as AccessGrant[]);
	if (value && typeof value === 'object' && ('read' in value || 'write' in value)) {
		return legacyAccessControlToGrants(value as LegacyAccessControl);
	}
	return [];
}

const isWildcard = (grant: AccessGrant, type: Principal, permission: Permission) =>
	grant.principal_type === type && grant.principal_id === WILDCARD && grant.permission === permission;

export const hasPublicReadGrant = (grants: AccessGrant[]) =>
	grants.some((g) => isWildcard(g, 'user', 'read'));
export const hasPublicWriteGrant = (grants: AccessGrant[]) =>
	grants.some((g) => isWildcard(g, 'user', 'write'));
export const hasAnyoneReadGrant = (grants: AccessGrant[]) =>
	grants.some((g) => isWildcard(g, 'anyone', 'read'));

/** "Open" outranks "public": an `anyone:*` grant makes the item link-viewable regardless. */
export function getVisibility(grants: AccessGrant[]): Visibility {
	if (hasAnyoneReadGrant(grants)) return 'open';
	if (hasPublicReadGrant(grants)) return 'public';
	return 'private';
}

/**
 * Replaces whatever wildcard grants exist with the one `visibility` implies.
 * Named principals (specific users and groups) are untouched, and a public
 * *write* grant is dropped along with the wildcard read it depended on.
 */
export function setVisibility(grants: AccessGrant[], visibility: Visibility): AccessGrant[] {
	const kept = grants.filter(
		(g) => !((g.principal_type === 'user' || g.principal_type === 'anyone') && g.principal_id === WILDCARD)
	);
	if (visibility === 'public') {
		kept.push({ principal_type: 'user', principal_id: WILDCARD, permission: 'read' });
	} else if (visibility === 'open') {
		kept.push({ principal_type: 'anyone', principal_id: WILDCARD, permission: 'read' });
	}
	return dedupeAccessGrants(kept);
}

export function upsertPrincipalGrant(
	grants: AccessGrant[],
	principalType: Principal,
	principalId: string,
	permission: Permission
): AccessGrant[] {
	const exists = grants.some(
		(g) =>
			g.principal_type === principalType &&
			g.principal_id === principalId &&
			g.permission === permission
	);
	return exists
		? grants
		: [...grants, { principal_type: principalType, principal_id: principalId, permission }];
}

export function removePrincipalGrant(
	grants: AccessGrant[],
	principalType: Principal,
	principalId: string,
	permission: Permission
): AccessGrant[] {
	return grants.filter(
		(g) =>
			!(
				g.principal_type === principalType &&
				g.principal_id === principalId &&
				g.permission === permission
			)
	);
}

/** Drops both the read and the write grant: removing a row from the access list. */
export function removePrincipal(
	grants: AccessGrant[],
	principalType: Principal,
	principalId: string
): AccessGrant[] {
	return dedupeAccessGrants(
		removePrincipalGrant(
			removePrincipalGrant(grants, principalType, principalId, 'read'),
			principalType,
			principalId,
			'write'
		)
	);
}

/** Write implies read, so granting write also grants read; revoking write leaves read. */
export function togglePrincipalWrite(
	grants: AccessGrant[],
	principalType: Principal,
	principalId: string
): AccessGrant[] {
	const hasWrite = grants.some(
		(g) =>
			g.principal_type === principalType &&
			g.principal_id === principalId &&
			g.permission === 'write'
	);
	const next = hasWrite
		? removePrincipalGrant(grants, principalType, principalId, 'write')
		: upsertPrincipalGrant(
				upsertPrincipalGrant(grants, principalType, principalId, 'read'),
				principalType,
				principalId,
				'write'
			);
	return dedupeAccessGrants(next);
}

/** The public-write toggle: same as `togglePrincipalWrite` for `user:*`, but a plain write grant. */
export function togglePublicWrite(grants: AccessGrant[]): AccessGrant[] {
	return dedupeAccessGrants(
		hasPublicWriteGrant(grants)
			? removePrincipalGrant(grants, 'user', WILDCARD, 'write')
			: upsertPrincipalGrant(grants, 'user', WILDCARD, 'write')
	);
}

/** Adds each user/group at `defaultPermission`; a default of write also adds read. */
export function addAccess(
	grants: AccessGrant[],
	{ userIds, groupIds }: { userIds: string[]; groupIds: string[] },
	defaultPermission: Permission
): AccessGrant[] {
	let next = [...grants];
	const add = (type: Principal, id: string) => {
		if (defaultPermission === 'write') next = upsertPrincipalGrant(next, type, id, 'read');
		next = upsertPrincipalGrant(next, type, id, defaultPermission);
	};
	for (const id of groupIds) add('group', id);
	for (const id of userIds) add('user', id);
	return dedupeAccessGrants(next);
}

/** Distinct ids of one principal type holding `permission`. */
export function principalIdsByPermission(
	grants: AccessGrant[],
	principalType: 'user' | 'group',
	permission: Permission
): string[] {
	return Array.from(
		new Set(
			grants
				.filter((g) => g.principal_type === principalType && g.permission === permission)
				.map((g) => g.principal_id)
		)
	);
}
