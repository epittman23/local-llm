import { ArrowDown } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Back to the newest message when the conversation is scrolled up (#929,
 * NAV-5, FBK-3): a round button centred above the composer. While a reply is
 * still being written below the fold it says "New text below", with a dot,
 * so the reader knows the answer is growing. It is its own indicator, so it
 * is not announced. Fades in (MOT-1), not under reduced motion (MOT-2).
 * End and Ctrl+End in the conversation do the same, shown or not.
 */
export function JumpToLatest({
	shown,
	streaming,
	onJump,
	scroller,
	className
}: {
	shown: boolean;
	streaming: boolean;
	onJump: () => void;
	/** The conversation's scrolling region, where End jumps. */
	scroller: RefObject<HTMLElement | null>;
	className?: string;
}) {
	const jump = useRef(onJump);
	jump.current = onJump;
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onKey = (e: KeyboardEvent) => {
			if (!isJumpKey(e)) return;
			e.preventDefault();
			jump.current();
		};
		el.addEventListener('keydown', onKey);
		return () => el.removeEventListener('keydown', onKey);
	}, [scroller]);

	if (!shown) return null;
	// A floating layer over the conversation: opaque, so the text under it does not show through.
	const look = 'bg-surface-2 rounded-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200';
	if (streaming)
		return (
			<Button type="button" variant="outline" size="sm" className={cn(look, className)} onClick={onJump}>
				<span aria-hidden className="bg-brand size-2 rounded-full" />
				New text below
				<ArrowDown aria-hidden />
			</Button>
		);
	return (
		<Tip content="Jump to latest">
			<Button
				type="button"
				variant="outline"
				size="icon"
				aria-label="Jump to latest"
				className={cn(look, className)}
				onClick={onJump}
			>
				<ArrowDown />
			</Button>
		</Tip>
	);
}

/** Whether a key in the conversation jumps to its end: End or Ctrl+End, outside a field being edited. */
export function isJumpKey(e: { key: string; target: EventTarget | null }): boolean {
	if (e.key !== 'End') return false;
	const el = e.target as HTMLElement | null;
	return !el?.closest?.('input, textarea, select, [contenteditable="true"]');
}
