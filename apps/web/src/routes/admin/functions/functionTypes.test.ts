import { describe, expect, it } from 'vitest';
import { type FunctionListItem, filterAndSortFunctions, functionSharePayload, parseFunctionImport, sanitizeIncomingFunction } from './functionTypes';

const fn = (id: string, o: Partial<FunctionListItem> = {}): FunctionListItem => ({
	id,
	name: `Name ${id}`,
	type: 'pipe',
	user_id: 'me',
	updated_at: 100,
	...o
});
const base = { query: '', type: '', view: '', userId: 'me', sortKey: 'updated_at', direction: 'desc' as const };

describe('filterAndSortFunctions', () => {
	const list = [fn('a', { updated_at: 1 }), fn('b', { type: 'filter', updated_at: 3, user_id: 'other', user: { username: 'zed' } }), fn('c', { updated_at: 2 })];
	it('sorts newest first by default', () => {
		expect(filterAndSortFunctions(list, base).map((f) => f.id)).toEqual(['b', 'c', 'a']);
	});
	it('filters by type', () => {
		expect(filterAndSortFunctions(list, { ...base, type: 'filter' }).map((f) => f.id)).toEqual(['b']);
	});
	it('searches name, id and the author username', () => {
		expect(filterAndSortFunctions(list, { ...base, query: 'ZED' }).map((f) => f.id)).toEqual(['b']);
		expect(filterAndSortFunctions(list, { ...base, query: 'name c' }).map((f) => f.id)).toEqual(['c']);
	});
	it('splits created from shared by owner', () => {
		expect(filterAndSortFunctions(list, { ...base, view: 'created' }).map((f) => f.id)).toEqual(['c', 'a']);
		expect(filterAndSortFunctions(list, { ...base, view: 'shared' }).map((f) => f.id)).toEqual(['b']);
	});
	it('sorts by name ascending', () => {
		expect(filterAndSortFunctions(list, { ...base, sortKey: 'name', direction: 'asc' }).map((f) => f.id)).toEqual(['a', 'b', 'c']);
	});
});

describe('imports', () => {
	it('peels the community { function } wrapper and keeps only the editable fields', () => {
		const text = JSON.stringify([
			{ function: { id: 'x', name: 'X', content: 'code', meta: { description: 'd', manifest: { version: '1' } }, is_active: true, user_id: 'evil' } },
			{ id: 'y', name: 'Y', content: 'code2', meta: {} }
		]);
		expect(parseFunctionImport(text)).toEqual([
			{ id: 'x', name: 'X', content: 'code', meta: { description: 'd', manifest: { version: '1' } } },
			{ id: 'y', name: 'Y', content: 'code2', meta: { description: '' } }
		]);
	});
	it('skips entries that lack an id, name or code, and rejects non-arrays', () => {
		expect(parseFunctionImport(JSON.stringify([{ id: 'x', name: 'X' }, 'junk', null]))).toEqual([]);
		expect(() => parseFunctionImport('{}')).toThrow(/array/);
	});
	it('drops unknown fields (and grants) from an incoming function', () => {
		const out = sanitizeIncomingFunction({ id: 'x', name: 'X', content: 'c', access_grants: [{ principal_type: 'user' }], is_global: true });
		expect(out).toEqual({ id: 'x', name: 'X', content: 'c', meta: { description: '' } });
		expect(sanitizeIncomingFunction([])).toBeNull();
	});
	it('shares only its own fields', () => {
		expect(functionSharePayload({ id: 'x', name: 'X', content: 'c', meta: { a: 1 }, ...{ user: 'secret' } } as never)).toEqual({ id: 'x', name: 'X', meta: { a: 1 }, content: 'c' });
	});
});
