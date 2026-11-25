import { createNewNote, getNoteById, updateNoteById } from '@/lib/apis/notes';
import { markdownToHtml } from '@/lib/editor/markdown';
import { contentFromMarkdown, NEW_NOTE_TITLE } from './notesModel';

// The three ways a note and a chat meet (#1135): a note opened in a new chat,
// a reply saved into a note, and a selection in a note explained in a new chat.

/** What a note hands the new-chat page through the navigation state (not the URL: a quote can be long). */
export type NoteChatState = { draft?: string };

/** The new-chat page with the note attached (`?note=<id>`), and, for Explain this, the composer's draft. */
export const askAboutNote = (id: string, draft?: string) => ({
	to: `/?note=${encodeURIComponent(id)}`,
	options: { state: draft ? ({ draft } satisfies NoteChatState) : undefined }
});

/** The words the composer starts with when a selection is explained. */
export const EXPLAIN_PROMPT = 'Explain this.';

/** Markdown as a block quote, one `> ` per line (an empty line stays a bare `>`, which keeps the quote whole). */
export const quoteMarkdown = (md: string) =>
	md
		.trim()
		.split('\n')
		.map((line) => (line.trim() ? `> ${line}` : '>'))
		.join('\n');

/** The composer's draft for a selection: the quote, a blank line, then the request. */
export const explainDraft = (selectionMd: string) => `${quoteMarkdown(selectionMd)}\n\n${EXPLAIN_PROMPT}`;

export type SaveTarget = { kind: 'new'; title: string } | { kind: 'existing'; id: string };

/**
 * Writes a reply's Markdown into a note and returns the note's id and title.
 * A new note holds the reply alone; an existing one gets it after a blank
 * line, its Markdown and HTML both regenerated (the editor builds from the
 * Markdown while the note has no editor JSON, which this clears).
 */
export async function saveReplyToNote(token: string, target: SaveTarget, md: string) {
	if (target.kind === 'new') {
		const title = target.title.trim() || NEW_NOTE_TITLE;
		const res = await createNewNote(token, {
			title,
			data: { content: contentFromMarkdown(md) },
			meta: null,
			access_grants: []
		});
		if (!res?.id) throw new Error('The note could not be created');
		return { id: res.id as string, title };
	}
	const note = (await getNoteById(token, target.id)) as {
		id: string;
		title: string;
		data?: { content?: { md?: string } } | null;
	} | null;
	if (!note) throw new Error('The note could not be read');
	const existing = note.data?.content?.md ?? '';
	const merged = existing.trim() ? `${existing}\n\n${md}` : md;
	await updateNoteById(token, note.id, {
		title: note.title,
		data: { content: { json: null, html: markdownToHtml(merged), md: merged } }
	});
	return { id: note.id, title: note.title };
}
