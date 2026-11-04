import { describe, expect, it, vi } from 'vitest';
import {
	type FunctionListItem,
	filterAndSortFunctions,
	importFunctions,
	importSummary,
	parseFunctionImport,
	sanitizeIncomingFunction
} from './functionTypes';

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
	const list = [
		fn('a', { updated_at: 1 }),
		fn('b', { type: 'filter', updated_at: 3, user_id: 'other', user: { username: 'zed' } }),
		fn('c', { updated_at: 2 })
	];
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
		expect(filterAndSortFunctions(list, { ...base, sortKey: 'name', direction: 'asc' }).map((f) => f.id)).toEqual([
			'a',
			'b',
			'c'
		]);
	});
});

describe('imports', () => {
	it('peels the community { function } wrapper and keeps only the editable fields', () => {
		const text = JSON.stringify([
			{
				function: {
					id: 'x',
					name: 'X',
					content: 'code',
					meta: { description: 'd', manifest: { version: '1' } },
					is_active: true,
					user_id: 'evil'
				}
			},
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
		const out = sanitizeIncomingFunction({
			id: 'x',
			name: 'X',
			content: 'c',
			access_grants: [{ principal_type: 'user' }],
			is_global: true
		});
		expect(out).toEqual({ id: 'x', name: 'X', content: 'c', meta: { description: '' } });
		expect(sanitizeIncomingFunction([])).toBeNull();
	});
});

describe('importSummary (#209)', () => {
	it('says imported only when every function was created', () => {
		expect(importSummary(2, 2)).toEqual(['success', 'Functions imported successfully']);
	});
	it('says none were imported when every create failed', () => {
		expect(importSummary(0, 3)).toEqual(['error', 'No functions were imported']);
		expect(importSummary(0, 1)).toEqual(['error', 'The function was not imported']);
	});
	it('says how many when some failed', () => {
		expect(importSummary(1, 3)).toEqual(['warning', 'Imported 1 of 3 functions']);
	});
});

describe('importFunctions (#209)', () => {
	const run = async (create: (fn: string) => Promise<unknown>, functions = ['a', 'b']) => {
		const notify = vi.fn();
		await importFunctions(functions, create, notify);
		return notify.mock.calls;
	};

	it('says imported only when every create succeeded', async () => {
		expect(await run(async (id) => ({ id }))).toEqual([['success', 'Functions imported successfully']]);
	});
	it('reports each refused create, then that none were imported, when all failed', async () => {
		expect(await run(async (id) => Promise.reject(`${id} is taken`))).toEqual([
			['error', 'a is taken'],
			['error', 'b is taken'],
			['error', 'No functions were imported']
		]);
	});
	it('says how many when some failed, counting a create that returned nothing as failed', async () => {
		const calls = await run(async (id) => (id === 'b' ? null : { id }), ['a', 'b', 'c']);
		expect(calls).toEqual([['warning', 'Imported 2 of 3 functions']]);
	});
	it('creates the functions one at a time, in order', async () => {
		const seen: string[] = [];
		let active = 0;
		await run(
			async (id) => {
				active += 1;
				expect(active).toBe(1);
				await Promise.resolve();
				seen.push(id);
				active -= 1;
				return { id };
			},
			['a', 'b', 'c']
		);
		expect(seen).toEqual(['a', 'b', 'c']);
	});
});
