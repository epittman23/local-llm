import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { TEXT_MAX_BYTES } from '../limits';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** A Markdown file as the app renders other people's Markdown, at reading width (CNV-4, TYP-5). */
export function MarkdownView({ doc }: { doc: CanvasDocument }) {
	const text = useDocumentText(doc, TEXT_MAX_BYTES);
	if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	if (!text.data) return <Loading />;
	return (
		<div className="h-full overflow-auto p-4">
			<SafeMarkdown text={text.data.text} className="rich-text text-reading max-w-[72ch]" />
			{text.data.truncated ? (
				<Note>Showing the first {TEXT_MAX_BYTES / 1024} KiB; download it for the rest.</Note>
			) : null}
		</div>
	);
}
