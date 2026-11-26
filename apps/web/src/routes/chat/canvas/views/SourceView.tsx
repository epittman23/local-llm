import { type Ref, useId } from 'react';
import { CodeSurface, TAB_HELP } from '@/components/chat/CodeSurface';
import { errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { HIGHLIGHT_MAX_LINES, TEXT_MAX_BYTES } from '../limits';
import { canEditDocument, uneditableText } from '../present';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** highlight.js's name for what a document's source is written in. */
const languageOf = (doc: CanvasDocument) =>
	doc.kind === 'html' ? 'xml' : doc.kind === 'csv' ? 'plaintext' : (doc.language ?? 'plaintext');

/** The draft a document is being edited as: `SourceView` shows it in an editor instead of the fetched text. */
export type SourceEdit = {
	draft: string;
	setDraft: (value: string) => void;
	inputRef: Ref<HTMLTextAreaElement>;
	/** Ctrl or Cmd+S in the editor. */
	onSave: () => void;
};

/**
 * A document's text, read-only, with line numbers (CNV-4): the standard's
 * code surface. A fenced block shows the text the message holds, so it fills
 * in as the block streams; a file is fetched, up to a cap. A very long
 * document is shown without per-line highlighting, which would stall the panel.
 * With `edit` (CNV-6) the same surface is the editor of the draft, with how its
 * Tab and Esc keys work written under it. A file that cannot be edited faithfully
 * (cut at the cap, or not UTF-8) says so here.
 */
export function SourceView({ doc, edit }: { doc: CanvasDocument; edit?: SourceEdit }) {
	const hintId = useId();
	const text = useDocumentText(doc, TEXT_MAX_BYTES);
	let code: string;
	let truncated = false;
	if (doc.source.type === 'block') code = doc.source.text;
	else if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	else if (!text.data) return <Loading />;
	else {
		code = edit ? edit.draft : text.data.text;
		truncated = text.data.truncated;
	}
	const reason = text.data && canEditDocument(doc) ? uneditableText(text.data) : null;
	const language = code.split('\n').length > HIGHLIGHT_MAX_LINES ? 'plaintext' : languageOf(doc);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1">
				<CodeSurface
					code={code}
					language={language}
					edit={
						edit && {
							label: `Edit ${doc.name}`,
							onChange: edit.setDraft,
							inputRef: edit.inputRef,
							onSave: edit.onSave,
							describedBy: hintId
						}
					}
				/>
			</div>
			{edit && (
				<p id={hintId} className="text-foreground-muted text-dense border-t px-3 py-1.5">
					{TAB_HELP}
				</p>
			)}
			{truncated ? (
				<Note>Showing the first {TEXT_MAX_BYTES / 1024} KiB; download it for the rest, or to change it.</Note>
			) : null}
			{reason === 'encoding' ? <Note>This file is not UTF-8 text; download it to change it.</Note> : null}
		</div>
	);
}
