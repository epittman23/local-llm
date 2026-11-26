import type { ReactNode } from 'react';
import { isNotFound } from '@/components/common/Gone';
import { errorDetail, errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { CSV_MAX_BYTES, TEXT_MAX_BYTES } from '../limits';
import { PassagesNote } from './PassagesNote';
import { Note } from './parts';
import { useDocumentText } from './useDocumentText';

/**
 * What surrounds a knowledge file's own view (CNV-4): the passages cited from it, above, and, when the
 * server refuses the file, the one Note that says so, in place of the view (CNV-7). The server decides
 * access on every fetch: a file removed, or one this person may not read, is "not found" and sends no
 * data. The probe asks for what the view asks for (the same query), so it costs no second request;
 * for a kind with no text view (an image, a PDF, any other file) it reads one chunk.
 */
export function KnowledgeFrame({
	doc,
	preview,
	children
}: {
	doc: CanvasDocument;
	/** The preview, not the source, is showing: a table's preview reads more of the file. */
	preview: boolean;
	children: ReactNode;
}) {
	const textual = doc.kind === 'html' || doc.kind === 'markdown' || doc.kind === 'csv' || doc.kind === 'code';
	let cap = 1;
	if (textual) cap = doc.kind === 'csv' && preview ? CSV_MAX_BYTES : TEXT_MAX_BYTES;
	const probe = useDocumentText(doc, cap);
	const passages = doc.source.type === 'knowledge' ? doc.source.passages : [];
	let body = children;
	if (probe.isError)
		body = isNotFound(errorDetail(probe.error)) ? (
			<Note>You can’t open this file. It may have been removed, or you may no longer have access.</Note>
		) : (
			<Note>Could not show this file: {errorMessage(probe.error)}</Note>
		);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<PassagesNote passages={passages} />
			<div className="min-h-0 flex-1">{body}</div>
		</div>
	);
}
