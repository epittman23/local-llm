import { type AccessGrant, dedupeAccessGrants } from '@/lib/access/accessGrants';

export type ToolMeta = { description: string; manifest?: Record<string, unknown> };

export type ToolDraft = {
	id: string;
	name: string;
	meta: ToolMeta;
	content: string;
	access_grants: AccessGrant[];
};

/** A row of the tools list (which returns every tool the user can see, unpaginated). */
export type ToolListItem = {
	id: string;
	name: string;
	user_id?: string;
	write_access?: boolean;
	updated_at: number;
	meta?: { description?: string; manifest?: { version?: string; funding_url?: string } & Record<string, unknown> };
	user?: { name?: string; email?: string } | null;
};

const asString = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const ID_MAX = 200;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const CONTENT_MAX = 500_000;

/**
 * A tool arriving from outside the form: the community site (a cross-origin
 * message), a clone or link-import stashed in `sessionStorage.tool`. Shaped
 * rather than spread; `withGrants` is true only for the same-origin stash,
 * where a clone of a shared tool keeps its (well-formed) grants. A cross-origin
 * message never gets to choose who can use a tool -- which is code that runs on
 * the server.
 */
export function sanitizeIncomingTool(raw: unknown, { withGrants }: { withGrants: boolean }): ToolDraft | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const t = raw as Record<string, unknown>;
	const meta = (t.meta && typeof t.meta === 'object' ? t.meta : {}) as Record<string, unknown>;
	const manifest = meta.manifest && typeof meta.manifest === 'object' && !Array.isArray(meta.manifest) ? (meta.manifest as Record<string, unknown>) : undefined;
	return {
		id: asString(t.id, ID_MAX),
		name: asString(t.name, NAME_MAX),
		meta: { description: asString(meta.description, DESCRIPTION_MAX), ...(manifest ? { manifest } : {}) },
		content: asString(t.content, CONTENT_MAX),
		access_grants: withGrants && Array.isArray(t.access_grants) ? dedupeAccessGrants(t.access_grants as AccessGrant[]) : []
	};
}

/** Reduces an imported tools file to importable objects; grants are dropped (the file may be anyone's). */
export function parseToolImport(text: string): ToolDraft[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of tools.');
	return parsed.flatMap((item) => {
		const tool = sanitizeIncomingTool(item, { withGrants: false });
		return tool && tool.id && tool.name && tool.content ? [tool] : [];
	});
}

/** What the community site is sent for "Share": the tool's own fields, not its author or grants. */
export function toolSharePayload(tool: { id: string; name: string; meta?: unknown; content?: unknown }) {
	return { id: tool.id, name: tool.name, meta: tool.meta ?? {}, content: tool.content ?? '' };
}

/** Filters/sorts the (client-side) tools list exactly as Tools.svelte's setFilteredItems does. */
export function filterAndSortTools(
	tools: ToolListItem[],
	{ query, view, userId, sortKey, direction }: { query: string; view: string; userId?: string; sortKey: string; direction: 'asc' | 'desc' }
): ToolListItem[] {
	const q = query.toLowerCase();
	const filtered = tools.filter((t) => {
		if (query === '' && view === '') return true;
		const matches =
			(t.name || '').toLowerCase().includes(q) ||
			(t.id || '').toLowerCase().includes(q) ||
			(t.user?.name || '').toLowerCase().includes(q) ||
			(t.user?.email || '').toLowerCase().includes(q);
		const inView = view === '' || (view === 'created' && t.user_id === userId) || (view === 'shared' && t.user_id !== userId);
		return matches && inView;
	});
	const sign = direction === 'asc' ? 1 : -1;
	return [...filtered].sort((a, b) =>
		sortKey === 'name' ? sign * (a.name ?? '').localeCompare(b.name ?? '') : sign * ((a.updated_at ?? 0) - (b.updated_at ?? 0))
	);
}
