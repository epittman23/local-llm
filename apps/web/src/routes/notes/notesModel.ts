import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AccessGrant, Permission } from '@/lib/access/accessGrants';
import { updateNoteAccessGrants } from '@/lib/apis/notes';
import { markdownToHtml } from '@/lib/editor/markdown';
import type { SessionUser } from '@/lib/stores/authStore';
import { getTimeRange } from '@/lib/utils/api-helpers';

// The rules behind the Notes surface (components/notes/Notes.svelte,
// NoteEditor.svelte, utils.ts). A note's body is stored three ways at once --
// TipTap JSON, HTML and Markdown -- under `data.content`.

export type NoteContent = { json: unknown; html: string; md: string };
export type NoteListItem = {
	id: string;
	title: string;
	updated_at: number;
	is_pinned?: boolean;
	user?: { name?: string; email?: string } | null;
	data?: { content?: Partial<NoteContent> } | null;
	write_access?: boolean;
};

/** Notes grouped by when they were last updated (Today, Yesterday, ...), in the order they came. */
export function groupNotes<T extends { updated_at: number }>(notes: T[], now = new Date()): [string, T[]][] {
	const groups = new Map<string, T[]>();
	for (const n of notes) {
		const key = getTimeRange(n.updated_at / 1_000_000_000, now);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(n);
	}
	return [...groups.entries()];
}

/** Clicking the active column flips it; a new column starts newest-first for dates, A-Z for titles. */
export function nextSort(current: { key: string; direction: 'asc' | 'desc' }, key: string) {
	if (current.key === key)
		return { key, direction: current.direction === 'asc' ? ('desc' as const) : ('asc' as const) };
	return { key, direction: key === 'updated_at' ? ('desc' as const) : ('asc' as const) };
}

/** A new note's body from Markdown (or given HTML); the JSON is left for the editor to fill on first edit. */
export const contentFromMarkdown = (md = '', html?: string): NoteContent => ({
	json: null,
	html: html ?? (md ? markdownToHtml(md) : ''),
	md
});

/** What the editor loads: the JSON if there is any, else the HTML, else the Markdown rendered. */
export function editorContent(c: Partial<NoteContent> | null | undefined): unknown {
	if (c?.json) return c.json;
	if (c?.html) return c.html;
	return c?.md ? markdownToHtml(c.md) : '';
}

/** Only .md and .txt become notes; the title is the file name without its extension. */
export function importableNote(file: { name: string; type: string }): { title: string } | null {
	const ok = file.type === 'text/markdown' || file.type === 'text/plain' || /\.(md|txt)$/i.test(file.name);
	return ok ? { title: file.name.replace(/\.(md|txt)$/i, '') } : null;
}

/** A file name from a note title: no path separators or characters most file systems refuse. */
export const safeFileName = (title: string, ext: string) =>
	`${(title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'Untitled'}.${ext}`;

export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** The prompt the Svelte editor sends to generate a note title (kept word for word). */
export const titlePrompt = (content: string) => `### Task:
Generate a concise title summarizing the content in the content's primary language.
### Guidelines:
- The title should clearly represent the main theme or subject of the content.
- Keep it short: 2-4 words is best.
- Do not use emojis, quotation marks, or special formatting.
- Write the title in the content's primary language.
- Prioritize accuracy over creativity.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the raw JSON output, as this will cause direct parsing failure.
### Output:
JSON format: { "title": "your concise title here" }
### Examples:
- { "title": "Stock Trends" },
- { "title": "Chocolate Chip Cookies" },
- { "title": "Music Streaming" },
- { "title": "Remote Work" }
### Content:
<content>
${content}
</content>`;

/** The title out of a model's reply: the first `{...}` block's `title`, trimmed and capped; null if there is none. */
export function parseGeneratedTitle(reply: string): string | null {
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		const title = JSON.parse(reply.slice(start, end + 1))?.title;
		return typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null;
	} catch {
		return null;
	}
}

/**
 * The access dialog's options for a note, as NoteEditor.svelte passed them:
 * read and write grants, with sharing, Public and named users each gated by
 * the user's own sharing permissions (admins get all three).
 */
export function noteAccessProps(user: SessionUser | null) {
	const isAdmin = user?.role === 'admin';
	return {
		accessRoles: ['read', 'write'] as Permission[],
		share: Boolean(user?.permissions?.sharing?.notes) || isAdmin,
		sharePublic: Boolean(user?.permissions?.sharing?.public_notes) || isAdmin,
		shareUsers: (user?.permissions?.access_grants?.allow_users ?? true) || isAdmin
	};
}

/**
 * The note with the grants the server stored. routers/notes.py drops grants
 * this user may not set, so caching the ones sent could show a note as public
 * that is stored private. Only `access_grants` is taken from the response; its
 * title and body may be older than an unsaved edit.
 */
export function withServerGrants<T extends { access_grants?: AccessGrant[] }>(
	note: T,
	res: { access_grants?: AccessGrant[] } | null | undefined
): T {
	return Array.isArray(res?.access_grants) ? { ...note, access_grants: res.access_grants } : note;
}

/** Sends a note's new grants and caches what the server stored; a failed update leaves the cache as it was. */
export async function saveNoteAccess(queryClient: QueryClient, token: string, id: string, grants: AccessGrant[]) {
	const res = await updateNoteAccessGrants(token, id, grants).catch((e) => void toast.error(`${e}`));
	if (!res) return;
	queryClient.setQueryData<{ access_grants?: AccessGrant[] }>(
		['notes', 'item', id],
		(old) => old && withServerGrants(old, res)
	);
	toast.success('Saved');
}
