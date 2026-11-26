import { FileCodeIcon, FileIcon, FileTextIcon, GlobeIcon, ImageIcon, TableIcon } from 'lucide-react';
import type { CanvasDocument } from '@/lib/chat/documents';
import { WEBUI_API_BASE_URL } from '@/lib/constants';

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
