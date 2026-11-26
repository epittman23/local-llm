import type { FileVersion } from '@/lib/apis/files/versions';
import type { CanvasDocument } from '@/lib/chat/documents';
import { ChangesView } from './views/ChangesView';
import { CsvView } from './views/CsvView';
import { DownloadView } from './views/DownloadView';
import { HtmlView } from './views/HtmlView';
import { ImageView } from './views/ImageView';
import { MarkdownView } from './views/MarkdownView';
import { PdfView } from './views/PdfView';
import { SourceView, type SourceEdit } from './views/SourceView';

export type Mode = 'preview' | 'source' | 'changes';

/** What the Changes view compares: the document's saved versions and which one is shown. */
export type ChangesOf = { versions: FileVersion[]; shownIndex: number };

/**
 * CNV-4: which views a document has. A page the model wrote or drew has both;
 * an uploaded page has only its source (it is never framed). Markdown and CSV
 * have both. Code has only its source. An image, a PDF and anything else have
 * only their one view.
 */
export function viewsOf(doc: CanvasDocument): { preview: boolean; source: boolean } {
	switch (doc.kind) {
		case 'html':
			return { preview: doc.source.type !== 'upload', source: true };
		case 'markdown':
		case 'csv':
			return { preview: true, source: true };
		case 'code':
			return { preview: false, source: true };
		default:
			return { preview: true, source: false };
	}
}

/** The canvas's body: one view of one document. A mode the document lacks falls back to the one it has; an edit is the source's; Changes is read-only. */
export function Canvas({
	doc,
	mode,
	reloads = 0,
	edit,
	changes
}: {
	doc: CanvasDocument;
	mode: Mode;
	reloads?: number;
	/** The draft being edited: the source view becomes its editor. */
	edit?: SourceEdit;
	/** Needed for mode `changes`, which compares two saved versions (CNV-9). */
	changes?: ChangesOf;
}) {
	const views = viewsOf(doc);
	const showing = mode === 'source' && views.source ? 'source' : views.preview ? 'preview' : 'source';
	let view: React.ReactNode;
	if (mode === 'changes' && changes)
		view = (
			<ChangesView
				key={`${doc.id}:${changes.shownIndex}`}
				doc={doc}
				versions={changes.versions}
				shownIndex={changes.shownIndex}
			/>
		);
	else if (showing === 'source') view = <SourceView doc={doc} edit={edit} />;
	else {
		switch (doc.kind) {
			case 'html':
				view = <HtmlView doc={doc} reloads={reloads} />;
				break;
			case 'markdown':
				view = <MarkdownView doc={doc} />;
				break;
			case 'csv':
				view = <CsvView doc={doc} />;
				break;
			case 'image':
				view = <ImageView doc={doc} />;
				break;
			case 'pdf':
				view = <PdfView doc={doc} />;
				break;
			default:
				view = <DownloadView doc={doc} />;
		}
	}
	return <div className="bg-background min-h-0 flex-1">{view}</div>;
}
