import { describe, expect, it } from 'vitest';
import {
	communitySharePayload,
	parsePromptImport,
	sanitizeExternalDraft,
	type PromptListItem
} from './promptTypes';

describe('sanitizeExternalDraft', () => {
	it('never carries access grants from outside, however they are spelled', () => {
		const draft = sanitizeExternalDraft({
			name: 'n',
			command: 'c',
			content: 'x',
			access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }],
			user_id: 'attacker'
		});
		expect(draft).toEqual({ name: 'n', command: 'c', content: 'x', tags: [], access_grants: [] });
	});

	it('coerces non-strings, accepts the legacy title field, and bounds lengths', () => {
		expect(sanitizeExternalDraft({ title: 'T', command: 5, content: null })).toMatchObject({
			name: 'T',
			command: '',
			content: ''
		});
		expect(sanitizeExternalDraft({ content: 'a'.repeat(200_000) })?.content).toHaveLength(100_000);
		expect(sanitizeExternalDraft({ tags: ['ok', 3, 'x'.repeat(500)] })?.tags).toEqual(['ok', 'x'.repeat(100)]);
	});

	it('rejects anything that is not a plain object', () => {
		for (const bad of [null, undefined, 'str', 4, ['a']]) expect(sanitizeExternalDraft(bad)).toBeNull();
	});
});

describe('parsePromptImport', () => {
	it('keeps valid entries, strips a leading slash, and skips bad commands', () => {
		const out = parsePromptImport(
			JSON.stringify([
				{ command: '/good', name: 'Good', content: 'c' },
				{ command: 'has space', name: 'Bad', content: 'c' },
				{ name: 'no command' },
				'not an object',
				{ command: 'nameless', content: 'c' }
			])
		);
		expect(out).toEqual([
			{ command: 'good', name: 'Good', content: 'c' },
			{ command: 'nameless', name: 'nameless', content: 'c' }
		]);
	});

	it('throws on a non-array file instead of importing nothing silently', () => {
		expect(() => parsePromptImport('{"command":"x"}')).toThrow(/array/);
		expect(() => parsePromptImport('not json')).toThrow();
	});
});

describe('communitySharePayload', () => {
	it("sends only the prompt's own fields, not the author or its grants", () => {
		const row: PromptListItem = {
			id: 'p1',
			name: 'N',
			command: 'c',
			content: 'body',
			tags: ['t'],
			created_at: 1,
			user: { id: 'u', name: 'Alice', email: 'alice@example.com' },
			access_grants: [{ principal_type: 'user', principal_id: 'u2', permission: 'read' }]
		};
		const payload = communitySharePayload(row);
		expect(payload).toEqual({ name: 'N', command: 'c', content: 'body', tags: ['t'] });
		expect(JSON.stringify(payload)).not.toContain('alice');
	});
});
