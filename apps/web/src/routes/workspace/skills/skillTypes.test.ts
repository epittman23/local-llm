import { describe, expect, it } from 'vitest';
import { formatSkillName, parseFrontmatter } from '@/lib/utils/skills';
import { parseSkillImport, sanitizeStashedSkill, toSkillDraft } from './skillTypes';

describe('parseFrontmatter / formatSkillName', () => {
	it('reads key: value lines, unquotes, and keeps colons inside values', () => {
		const fm = parseFrontmatter('---\nname: "code-review_guide"\ndescription: Step 1: read\n---\nbody');
		expect(fm.name).toBe('code-review_guide');
		expect(fm.description).toBe('Step 1: read');
		expect(formatSkillName(fm.name)).toBe('Code Review Guide');
	});

	it('returns nothing without a leading block, and cannot be poisoned via __proto__', () => {
		expect(Object.keys(parseFrontmatter('no frontmatter'))).toEqual([]);
		const fm = parseFrontmatter('---\n__proto__: polluted\n---');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(fm)).toBeNull();
	});
});

describe('parseSkillImport', () => {
	it('accepts one skill or an array, and drops grants and unknown fields', () => {
		const one = parseSkillImport(
			JSON.stringify({
				id: 's1',
				name: 'S',
				content: 'c',
				is_active: false,
				owner: 'x',
				access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }]
			})
		);
		expect(one).toEqual([
			{ id: 's1', name: 'S', description: '', content: 'c', is_active: false, meta: { tags: [] }, access_grants: [] }
		]);
		expect(
			parseSkillImport(
				JSON.stringify([
					{ id: 'a', name: 'A' },
					{ id: 'b', name: 'B' }
				])
			)
		).toHaveLength(2);
	});

	it('skips entries missing an id or name; throws on invalid JSON', () => {
		expect(parseSkillImport(JSON.stringify([{ id: 'a' }, { name: 'B' }, 3, null]))).toEqual([]);
		expect(() => parseSkillImport('nope')).toThrow();
	});
});

describe('sanitizeStashedSkill', () => {
	it('keeps well-formed grants (a clone of a shared skill stays shared) and drops malformed ones', () => {
		const out = sanitizeStashedSkill({
			id: 'x_clone',
			name: 'X (Clone)',
			access_grants: [{ principal_type: 'group', principal_id: 'g1', permission: 'read' }, { principal_type: 'group' }]
		});
		expect(out?.access_grants).toEqual([
			{ id: undefined, principal_type: 'group', principal_id: 'g1', permission: 'read' }
		]);
		expect(out?.is_active).toBe(true);
	});

	it('rejects non-objects', () => {
		expect(sanitizeStashedSkill('x')).toBeNull();
		expect(sanitizeStashedSkill([1])).toBeNull();
	});
});

describe('toSkillDraft', () => {
	it('keeps is_active and the tags a save writes back (#227), and defaults missing grants', () => {
		expect(
			toSkillDraft({
				id: 's',
				name: 'S',
				description: 'd',
				content: 'c',
				is_active: false,
				meta: { tags: ['a', 'b'] }
			})
		).toEqual({
			id: 's',
			name: 'S',
			description: 'd',
			content: 'c',
			is_active: false,
			meta: { tags: ['a', 'b'] },
			access_grants: []
		});
	});

	it('reads null or missing tags (SkillMeta.tags is nullable) as none', () => {
		const base = { id: 's', name: 'S', description: '', content: '', is_active: true, access_grants: [] };
		expect(toSkillDraft({ ...base, meta: { tags: null } }).meta).toEqual({ tags: [] });
		expect(toSkillDraft(base).meta).toEqual({ tags: [] });
	});
});
