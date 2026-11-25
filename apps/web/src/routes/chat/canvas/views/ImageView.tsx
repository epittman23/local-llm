import type { CanvasDocument } from '@/lib/chat/documents';
import { contentUrl, fileIdOf } from '../present';

/**
 * An image file fitted to the canvas (CNV-4), always as an `<img>` from the
 * content route, an SVG file included: never inline markup, never a frame, so
 * a drawing's script cannot run. The surround is the theme's surface.
 */
export function ImageView({ doc }: { doc: CanvasDocument }) {
	const id = fileIdOf(doc);
	if (id === null) return null;
	return (
		<div className="bg-surface-1 flex h-full items-center justify-center overflow-auto p-3">
			<img src={contentUrl(id)} alt={doc.name} className="max-h-full max-w-full object-contain" />
		</div>
	);
}
