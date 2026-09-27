import { markdownToHtml } from '@/lib/editor/markdown';
import { getTimeRange } from '@/lib/utils/api-helpers';

// The rules behind the Notes surface (components/notes/Notes.svelte,
// NoteEditor.svelte, utils.ts). A note's body is stored three ways at once --
// TipTap JSON, HTML and Markdown -- under `data.content`.

export type NoteContent = { json: unknown; html: string; md: string };
export type NoteListItem = { id: string; title: string; updated_at: number; is_pinned?: boolean; user?: { name?: string; email?: string } | null; data?: { content?: Partial<NoteContent> } | null; write_access?: boolean };

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
	if (current.key === key) return { key, direction: current.direction === 'asc' ? ('desc' as const) : ('asc' as const) };
	return { key, direction: key === 'updated_at' ? ('desc' as const) : ('asc' as const) };
}

/** A new note's body from Markdown (or given HTML); the JSON is left for the editor to fill on first edit. */
export const contentFromMarkdown = (md = '', html?: string): NoteContent => ({ json: null, html: html ?? (md ? markdownToHtml(md) : ''), md });

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
export const safeFileName = (title: string, ext: string) => `${(title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'Untitled'}.${ext}`;

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
