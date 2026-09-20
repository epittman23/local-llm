import { sanitizeIncomingTool } from '@/routes/workspace/tools/toolTypes';

export type FunctionType = 'pipe' | 'filter' | 'action' | 'event' | string;

export type FunctionMeta = { description: string; manifest?: Record<string, unknown> };

/** The fields the editor edits and the create/update endpoints accept. */
export type FunctionDraft = { id: string; name: string; meta: FunctionMeta; content: string };

/** A row of the functions list (unpaginated, every function the admin can see). */
export type FunctionListItem = {
	id: string;
	name: string;
	type: FunctionType;
	user_id?: string;
	updated_at: number;
	is_active?: boolean;
	is_global?: boolean;
	meta?: { description?: string; manifest?: { version?: string; funding_url?: string } & Record<string, unknown> };
	user?: { name?: string; email?: string; username?: string } | null;
};

export const FUNCTION_TYPES: { value: FunctionType; label: string }[] = [
	{ value: 'pipe', label: 'Pipe' },
	{ value: 'filter', label: 'Filter' },
	{ value: 'action', label: 'Action' },
	{ value: 'event', label: 'Event' }
];

/**
 * A function arriving from outside the form -- the community site's message, or
 * a clone / link import left in `sessionStorage.function`. Shaped, not spread:
 * the editor sends `{id, name, meta, content}` and nothing else, so anything
 * else on the incoming object (including a cross-origin message's) is dropped
 * here rather than trusted to be inert. Same rules as tools, minus grants
 * (functions have none), so this delegates to the tool sanitizer.
 */
export function sanitizeIncomingFunction(raw: unknown): FunctionDraft | null {
	const t = sanitizeIncomingTool(raw, { withGrants: false });
	return t ? { id: t.id, name: t.name, meta: t.meta, content: t.content } : null;
}

/**
 * Reduces an imported functions file to importable objects. The community's
 * export wraps each function as `{ function: {...} }`; that layer is peeled off
 * first (Functions.svelte does the same). Entries without an id, name and code
 * are skipped rather than sent to fail one by one.
 */
export function parseFunctionImport(text: string): FunctionDraft[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of functions.');
	return parsed.flatMap((item) => {
		const inner = item && typeof item === 'object' && 'function' in item ? (item as { function: unknown }).function : item;
		const fn = sanitizeIncomingFunction(inner);
		return fn && fn.id && fn.name && fn.content ? [fn] : [];
	});
}

/** "Share to Community" sends the function's own fields, not its author record. */
export function functionSharePayload(fn: { id: string; name: string; meta?: unknown; content?: unknown }) {
	return { id: fn.id, name: fn.name, meta: fn.meta ?? {}, content: fn.content ?? '' };
}

/** Filters/sorts the (client-side) list exactly as Functions.svelte's setFilteredItems does. */
export function filterAndSortFunctions(
	functions: FunctionListItem[],
	{
		query,
		type,
		view,
		userId,
		sortKey,
		direction
	}: { query: string; type: string; view: string; userId?: string; sortKey: string; direction: 'asc' | 'desc' }
): FunctionListItem[] {
	const q = query.toLowerCase();
	const filtered = functions.filter((f) => {
		if (type !== '' && f.type !== type) return false;
		const matches =
			query === '' ||
			f.name.toLowerCase().includes(q) ||
			f.id.toLowerCase().includes(q) ||
			(f.user?.name || '').toLowerCase().includes(q) ||
			(f.user?.email || '').toLowerCase().includes(q) ||
			(f.user?.username || '').toLowerCase().includes(q);
		const inView = view === '' || (view === 'created' && f.user_id === userId) || (view === 'shared' && f.user_id !== userId);
		return matches && inView;
	});
	const sign = direction === 'asc' ? 1 : -1;
	return [...filtered].sort((a, b) =>
		sortKey === 'name' ? sign * (a.name ?? '').localeCompare(b.name ?? '') : sign * ((a.updated_at ?? 0) - (b.updated_at ?? 0))
	);
}
