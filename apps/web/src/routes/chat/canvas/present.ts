import { FileCodeIcon, FileIcon, FileTextIcon, GlobeIcon, ImageIcon, TableIcon } from 'lucide-react';
import type { FileVersion } from '@/lib/apis/files/versions';
import { type CanvasDocument, UUID } from '@/lib/chat/documents';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
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

/**
 * Whether the document is one the canvas can edit (CNV-6, docs/plans/canvas.md C14): Markdown, text or code
 * that is a file, a sandbox output or an upload, and no larger than the most the canvas loads. A fenced
 * block is message text with no file to version; a page, a table, an image and a PDF are not edited yet.
 */
export function canEditDocument(doc: CanvasDocument): boolean {
	if (doc.kind !== 'markdown' && doc.kind !== 'code') return false;
	if (doc.source.type !== 'output' && doc.source.type !== 'upload') return false;
	if (!UUID.test(doc.source.fileId)) return false;
	return doc.bytes === null || doc.bytes <= TEXT_MAX_BYTES;
}

/** Why the fetched text cannot be edited, or null when it can: cut at the cap, or not UTF-8 (saving would corrupt it). */
export function uneditableText(text: { text: string; truncated: boolean }): 'truncated' | 'encoding' | null {
	if (text.truncated) return 'truncated';
	return text.text.includes('\uFFFD') ? 'encoding' : null;
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
 * Versions are only listed for what `canEditDocument` accepts, so a block, an image, a PDF, a page and a table have none.
 */
export function hasChanges(doc: CanvasDocument, versions: readonly unknown[]): boolean {
	return versions.length > 1 && canEditDocument(doc);
}
