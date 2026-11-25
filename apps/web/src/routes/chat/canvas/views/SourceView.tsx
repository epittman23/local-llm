import { CodeSurface } from '@/components/chat/CodeSurface';
import { errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { HIGHLIGHT_MAX_LINES, TEXT_MAX_BYTES } from '../limits';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** highlight.js's name for what a document's source is written in. */
const languageOf = (doc: CanvasDocument) =>
	doc.kind === 'html' ? 'xml' : doc.kind === 'csv' ? 'plaintext' : (doc.language ?? 'plaintext');

/**
 * A document's text, read-only, with line numbers (CNV-4): the standard's
 * code surface. A fenced block shows the text the message holds, so it fills
 * in as the block streams; a file is fetched, up to a cap. A very long
 * document is shown without per-line highlighting, which would stall the panel.
 */
export function SourceView({ doc }: { doc: CanvasDocument }) {
	const text = useDocumentText(doc, TEXT_MAX_BYTES);
	let code: string;
	let truncated = false;
	if (doc.source.type === 'block') code = doc.source.text;
	else if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	else if (!text.data) return <Loading />;
	else {
		code = text.data.text;
		truncated = text.data.truncated;
	}
	const language = code.split('\n').length > HIGHLIGHT_MAX_LINES ? 'plaintext' : languageOf(doc);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1">
				<CodeSurface code={code} language={language} />
			</div>
			{truncated ? <Note>Showing the first {TEXT_MAX_BYTES / 1024} KiB; download it for the rest.</Note> : null}
		</div>
	);
}
