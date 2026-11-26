import { FileCodeIcon, FileIcon, FileTextIcon, GlobeIcon, ImageIcon, TableIcon } from 'lucide-react';
import type { FileVersion } from '@/lib/apis/files/versions';
import { type CanvasDocument, UUID } from '@/lib/chat/documents';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import type { CsvNotFaithful } from '@/lib/utils/csvTable';
import { dayjs } from '@/lib/utils/dates';
import { TEXT_MAX_BYTES } from './limits';

/** Where a file's bytes are served (GET /files/{id}/content). `id` is a UUID (`documents.ts` accepts nothing else). */
export const contentUrl = (id: string, attachment = false) =>
	`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(id)}/content${attachment ? '?attachment=true' : ''}`;

/** The file's id, or null for a fenced block, which has no file. */
export const fileIdOf = (doc: CanvasDocument) => (doc.source.type === 'block' ? null : doc.source.fileId);

/** The kind as a person says it, shown beside the name. */
export function kindLabel(doc: CanvasDocument): string {
	switch (doc.kind) {
		case 'html':
			return doc.language === 'svg' ? 'SVG' : 'HTML';
		case 'markdown':
			return 'Markdown';
		case 'csv':
			return 'CSV';
		case 'image':
			return 'Image';
		case 'pdf':
			return 'PDF';
		case 'download':
			return 'File';
		default: {
			const language = doc.language && doc.language !== 'plaintext' ? doc.language : 'Text';
			return language.charAt(0).toUpperCase() + language.slice(1);
		}
	}
}

export function kindIcon(doc: CanvasDocument) {
	switch (doc.kind) {
		case 'html':
			return GlobeIcon;
		case 'markdown':
		case 'pdf':
			return FileTextIcon;
		case 'code':
			return FileCodeIcon;
		case 'csv':
			return TableIcon;
		case 'image':
			return ImageIcon;
		default:
			return FileIcon;
	}
}

/** A size in bytes as a person reads it: "300 B", "1.5 kB", "12 kB", "2.3 MB". Empty when it is not known. */
export function formatSize(bytes: number | null): string {
	if (bytes === null) return '';
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
	const mb = kb / 1024;
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** How a document can be edited (CNV-6) and whether the draft has a preview beside it. */
export type Editability = {
	canEdit: boolean;
	/** A fenced block: the draft is tried and never saved, as a block has no file to version. */
	draftOnly: boolean;
	/** The draft is shown in the sandboxed frame beside its source: a page the model wrote, or a block of one. */
	preview: boolean;
};

const NOT_EDITABLE: Editability = { canEdit: false, draftOnly: false, preview: false };

/**
 * The one rule for what the canvas edits (CNV-6, docs/plans/canvas.md C14): Markdown, text, code, CSV and
 * HTML that is a file, a sandbox output or an upload, no larger than the most the canvas loads. A page the
 * model wrote (an output) has its draft previewed in the sandboxed frame; an uploaded page is the person's
 * file and is never framed, so it is edited as source only. A closed `html` or `svg` block can be tried
 * (`draftOnly`) but has no file to save; any other block, an image and a PDF are not edited. A CSV is edited
 * as a table when it is faithful (`parseCsvTable`) and as text otherwise.
 */
export function editabilityOf(doc: CanvasDocument): Editability {
	const { source } = doc;
	if (source.type === 'block') {
		const markup = doc.kind === 'html' && (source.language === 'html' || source.language === 'svg');
		if (!markup || !source.closed || new TextEncoder().encode(source.text).length > TEXT_MAX_BYTES) return NOT_EDITABLE;
		return { canEdit: true, draftOnly: true, preview: true };
	}
	if (doc.kind !== 'markdown' && doc.kind !== 'code' && doc.kind !== 'html' && doc.kind !== 'csv') return NOT_EDITABLE;
	if (source.type !== 'output' && source.type !== 'upload') return NOT_EDITABLE;
	if (!UUID.test(source.fileId)) return NOT_EDITABLE;
	if (doc.bytes !== null && doc.bytes > TEXT_MAX_BYTES) return NOT_EDITABLE;
	return { canEdit: true, draftOnly: false, preview: doc.kind === 'html' && source.type === 'output' };
}

/** Whether the document is a file whose edit is saved as a new version (not a block, whose draft is only tried). */
export function canEditDocument(doc: CanvasDocument): boolean {
	const editability = editabilityOf(doc);
	return editability.canEdit && !editability.draftOnly;
}

/** Why the fetched text cannot be edited, or null when it can: cut at the cap, or not UTF-8 (saving would corrupt it). */
export function uneditableText(text: { text: string; truncated: boolean }): 'truncated' | 'encoding' | null {
	if (text.truncated) return 'truncated';
	return text.text.includes('\uFFFD') ? 'encoding' : null;
}

/** The Note under a CSV that is edited as text because it cannot be edited as a table. */
export function tableNote(reason: CsvNotFaithful): string {
	switch (reason) {
		case 'size':
			return 'Too large to edit as a table. Edit it as text.';
		case 'delimiter':
			return 'Only comma-separated files can be edited as a table. Edit it as text.';
		default:
			return 'Saving it as a table would change more than its quoting. Edit it as text.';
	}
}

/** The document as one of its saved versions: its file is the version's, so every view, Copy and Download use that one. */
export function withVersion(doc: CanvasDocument, version: Pick<FileVersion, 'id' | 'size'> | null): CanvasDocument {
	if (!version || (doc.source.type !== 'output' && doc.source.type !== 'upload')) return doc;
	return { ...doc, bytes: version.size ?? doc.bytes, source: { ...doc.source, fileId: version.id } };
}

/** "Version 2, 14:05": the time of day for today's, with the date for an older one. */
export function versionLabel(version: FileVersion, index: number): string {
	if (index === 0) return 'Version 1 (original)';
	if (!version.created_at) return `Version ${index + 1}`;
	const at = dayjs(version.created_at * 1000);
	return `Version ${index + 1}, ${at.format(at.isToday() ? 'HH:mm' : 'YYYY-MM-DD HH:mm')}`;
}

/**
 * Whether the document has a Changes view (CNV-9): a text document with more than one saved version.
 * Versions are only listed for what `canEditDocument` accepts, so a block, an image and a PDF have none.
 */
export function hasChanges(doc: CanvasDocument, versions: readonly unknown[]): boolean {
	return versions.length > 1 && canEditDocument(doc);
}
