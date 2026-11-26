import { Markdown } from '@/components/chat/markdown/Markdown';
import { errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { TEXT_MAX_BYTES } from '../limits';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** A Markdown file as the chat renders Markdown (CNV-4): its headings, lists, tables and code, with no message actions, at reading width (TYP-5). */
export function MarkdownView({ doc }: { doc: CanvasDocument }) {
	const text = useDocumentText(doc, TEXT_MAX_BYTES);
	if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	if (!text.data) return <Loading />;
	return (
		<div className="h-full overflow-auto p-4">
			{/* A leading byte-order mark is kept in the text for saving; Markdown would read it as text before the first heading. */}
			<Markdown id={`canvas-${doc.id}`} content={text.data.text.replace(/^\uFEFF/, '')} className="max-w-[72ch]" />
			{text.data.truncated ? (
				<Note>Showing the first {TEXT_MAX_BYTES / 1024} KiB; download it for the rest.</Note>
			) : null}
		</div>
	);
}
