import { type AccessGrant, dedupeAccessGrants } from '@/lib/access/accessGrants';

export type SkillDraft = {
	id: string;
	name: string;
	description: string;
	content: string;
	is_active: boolean;
	meta?: { tags: string[] };
	access_grants: AccessGrant[];
};

export type SkillListItem = {
	id: string;
	name: string;
	description?: string;
	is_active: boolean;
	write_access?: boolean;
	created_at: number;
	updated_at?: number;
	user?: { name?: string; email?: string } | null;
};

const asString = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const ID_MAX = 200;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const CONTENT_MAX = 200_000;

/**
 * A skill read back from `sessionStorage.skill` (where Clone and "import a
 * .md file" leave it for the create page). Same-origin, so trusted to be the
 * app's own data -- but still shaped rather than spread, so a stale or foreign
 * entry can't put unexpected fields into the create form. Grants are kept (a
 * clone of a shared skill starts shared, as in the Svelte app) but only if
 * they are well-formed.
 */
export function sanitizeStashedSkill(raw: unknown): SkillDraft | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const s = raw as Record<string, unknown>;
	return {
		name: asString(s.name, NAME_MAX) || 'Skill',
		id: asString(s.id, ID_MAX),
		description: asString(s.description, DESCRIPTION_MAX),
		content: asString(s.content, CONTENT_MAX),
		is_active: typeof s.is_active === 'boolean' ? s.is_active : true,
		access_grants: Array.isArray(s.access_grants) ? dedupeAccessGrants(s.access_grants as AccessGrant[]) : []
	};
}

/**
 * Parses an imported skills file: one skill object or an array of them.
 * Each is reduced to its own fields, and **grants are dropped** -- a skills
 * export is a file people pass around, and importing one must not be able to
 * publish the result. (The Svelte importer POSTs each object as-is.) An
 * exported-then-imported skill therefore comes back private; share it again
 * from the editor.
 */
export function parseSkillImport(text: string): SkillDraft[] {
	const parsed: unknown = JSON.parse(text);
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items.flatMap((item) => {
		if (!item || typeof item !== 'object') return [];
		const s = item as Record<string, unknown>;
		const id = asString(s.id, ID_MAX);
		const name = asString(s.name, NAME_MAX);
		if (!id || !name) return [];
		const tags = (s.meta as { tags?: unknown } | undefined)?.tags;
		return [
			{
				id,
				name,
				description: asString(s.description, DESCRIPTION_MAX),
				content: asString(s.content, CONTENT_MAX),
				is_active: typeof s.is_active === 'boolean' ? s.is_active : true,
				meta: { tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [] },
				access_grants: []
			}
		];
	});
}
