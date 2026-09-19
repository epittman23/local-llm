import { describe, expect, it } from 'vitest';
import { filterAndSortTools, parseToolImport, sanitizeIncomingTool, toolSharePayload, type ToolListItem } from './toolTypes';

const grants = [{ principal_type: 'user', principal_id: '*', permission: 'write' }];

describe('sanitizeIncomingTool', () => {
	it('never takes grants from a cross-origin message, but keeps well-formed ones from the same-origin stash', () => {
		const raw = { id: 't', name: 'T', content: 'c', meta: { description: 'd' }, access_grants: grants };
		expect(sanitizeIncomingTool(raw, { withGrants: false })?.access_grants).toEqual([]);
		expect(sanitizeIncomingTool(raw, { withGrants: true })?.access_grants).toHaveLength(1);
	});
	it('shapes fields, bounds lengths, and rejects non-objects', () => {
		expect(sanitizeIncomingTool({ id: 5, content: 'x'.repeat(600_000) }, { withGrants: false })).toMatchObject({ id: '', content: 'x'.repeat(500_000) });
		expect(sanitizeIncomingTool('s', { withGrants: false })).toBeNull();
	});
	it('keeps a manifest object but not a manifest array', () => {
		expect(sanitizeIncomingTool({ meta: { manifest: { version: '1' } } }, { withGrants: false })?.meta.manifest).toEqual({ version: '1' });
		expect(sanitizeIncomingTool({ meta: { manifest: [1] } }, { withGrants: false })?.meta.manifest).toBeUndefined();
	});
});

describe('parseToolImport', () => {
	it('requires an array, drops grants, and skips entries without id, name or content', () => {
		const out = parseToolImport(JSON.stringify([{ id: 'a', name: 'A', content: 'c', access_grants: grants }, { id: 'b', name: 'B' }, 4]));
		expect(out).toHaveLength(1);
		expect(out[0].access_grants).toEqual([]);
		expect(() => parseToolImport('{}')).toThrow(/array/);
	});
});

describe('toolSharePayload', () => {
	it('omits the author and grants', () => {
		const p = toolSharePayload({ id: 't', name: 'T', content: 'c', meta: { description: 'd' }, user: { email: 'a@b.c' }, access_grants: grants } as never);
		expect(JSON.stringify(p)).not.toContain('a@b.c');
		expect(p).toEqual({ id: 't', name: 'T', meta: { description: 'd' }, content: 'c' });
	});
});

describe('filterAndSortTools', () => {
	const tools: ToolListItem[] = [
		{ id: 'weather', name: 'Weather', user_id: 'me', updated_at: 1, user: { name: 'Me', email: 'me@x.io' } },
		{ id: 'calc', name: 'Calculator', user_id: 'you', updated_at: 3, user: { name: 'You', email: 'you@x.io' } },
		{ id: 'clock', name: 'Clock', user_id: 'me', updated_at: 2 }
	];
	it('searches name, id, author name and email; and filters by view', () => {
		expect(filterAndSortTools(tools, { query: 'you@', view: '', sortKey: 'name', direction: 'asc' }).map((t) => t.id)).toEqual(['calc']);
		expect(filterAndSortTools(tools, { query: '', view: 'created', userId: 'me', sortKey: 'name', direction: 'asc' }).map((t) => t.id)).toEqual(['clock', 'weather']);
		expect(filterAndSortTools(tools, { query: '', view: 'shared', userId: 'me', sortKey: 'name', direction: 'asc' }).map((t) => t.id)).toEqual(['calc']);
	});
	it('sorts by name or updated_at in either direction', () => {
		expect(filterAndSortTools(tools, { query: '', view: '', sortKey: 'updated_at', direction: 'desc' }).map((t) => t.id)).toEqual(['calc', 'clock', 'weather']);
		expect(filterAndSortTools(tools, { query: '', view: '', sortKey: 'name', direction: 'desc' }).map((t) => t.id)).toEqual(['weather', 'clock', 'calc']);
	});
});
