import { Paperclip } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';

/** Whether a drag carries files (not text or a link dragged from the page). */
export const isFileDrag = (dt: DataTransfer | null) => Boolean(dt && Array.from(dt.types).includes('Files'));

/**
 * Whether files are being dragged over an element, for its drop overlay
 * (#1084). Counts enters and leaves, since moving over each child fires a
 * pair; a drop anywhere, or a drag that ends, resets it.
 */
export function useFileDrag() {
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		const reset = () => {
			depth.current = 0;
			setDragging(false);
		};
		window.addEventListener('drop', reset);
		window.addEventListener('dragend', reset);
		return () => {
			window.removeEventListener('drop', reset);
			window.removeEventListener('dragend', reset);
		};
	}, []);
	return {
		dragging,
		onDragEnter(e: DragEvent) {
			if (!isFileDrag(e.dataTransfer)) return;
			depth.current += 1;
			setDragging(true);
		},
		onDragLeave(e: DragEvent) {
			if (!isFileDrag(e.dataTransfer)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setDragging(false);
		},
		onDrop() {
			depth.current = 0;
			setDragging(false);
		}
	};
}

/**
 * What the chat shows while files are dragged over it (#1084, FBK-1, FBK-3):
 * a dashed drop zone over the whole column saying what a drop does. It lets
 * the drag events through to the column underneath.
 */
export function DropOverlay({ shown }: { shown: boolean }) {
	if (!shown) return null;
	return (
		<div
			data-testid="drop-overlay"
			className="border-border-control bg-surface-1 text-body font-strong rounded-panel pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 border-2 border-dashed motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
		>
			<Paperclip aria-hidden className="text-muted-foreground size-6" />
			Drop files to attach them to your message
		</div>
	);
}
