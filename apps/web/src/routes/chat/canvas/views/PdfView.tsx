import type { CanvasDocument } from '@/lib/chat/documents';
import { contentUrl } from '../present';
import { DownloadView } from './DownloadView';

/**
 * A PDF as its page images in page order (the server renders them as
 * `preview_of` files), fitted to the canvas (CNV-4). A PDF with no page
 * images is a download.
 */
export function PdfView({ doc }: { doc: CanvasDocument }) {
	const pages = doc.source.type === 'output' ? doc.source.previews : [];
	if (!pages.length) return <DownloadView doc={doc} />;
	return (
		<div className="bg-surface-1 flex h-full flex-col items-center gap-3 overflow-auto p-3">
			{pages.map((p, i) => (
				<img
					key={p.id}
					src={contentUrl(p.id)}
					alt={`${doc.name}, page ${p.page || i + 1}`}
					loading="lazy"
					className="border-border max-w-full border"
				/>
			))}
		</div>
	);
}
