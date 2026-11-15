import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { isJumpKey, JumpToLatest } from './JumpToLatest';

function Harness({
	shown = true,
	streaming = false,
	onJump
}: {
	shown?: boolean;
	streaming?: boolean;
	onJump: () => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	return (
		<TooltipProvider>
			<div ref={scroller} data-testid="scroller">
				<button type="button">Copy</button>
				<textarea aria-label="Edit message" />
			</div>
			<JumpToLatest shown={shown} streaming={streaming} onJump={onJump} scroller={scroller} className="absolute" />
		</TooltipProvider>
	);
}

afterEach(cleanup);

describe('JumpToLatest', () => {
	it('is a round, named icon button while the reader is away from the end (#929, ACT-4)', () => {
		const onJump = vi.fn();
		render(<Harness onJump={onJump} />);
		const button = screen.getByRole('button', { name: 'Jump to latest' });
		expect(button.className).toContain('rounded-full');
		// Opaque, floating over the conversation.
		expect(button.className).toContain('bg-surface-2');
		expect(button.className).toContain('absolute');
		// MOT-1, MOT-2: it fades in, except under reduced motion.
		expect(button.className).toContain('motion-safe:fade-in-0');
		expect(button.className).toContain('motion-safe:duration-200');
		fireEvent.click(button);
		expect(onJump).toHaveBeenCalledTimes(1);
	});

	it('says "New text below", with a dot, while a reply is written below the fold', () => {
		const onJump = vi.fn();
		render(<Harness onJump={onJump} streaming />);
		const button = screen.getByRole('button', { name: 'New text below' });
		expect(button.querySelector('.rounded-full.bg-brand')).not.toBeNull();
		fireEvent.click(button);
		expect(onJump).toHaveBeenCalledTimes(1);
	});

	it('is not there at the end of the conversation', () => {
		render(<Harness onJump={vi.fn()} shown={false} />);
		expect(screen.queryByRole('button', { name: /latest|below/ })).toBeNull();
	});

	it('jumps on End and Ctrl+End in the conversation, but not in a field being edited', () => {
		const onJump = vi.fn();
		render(<Harness onJump={onJump} shown={false} />);
		fireEvent.keyDown(screen.getByRole('button', { name: 'Copy' }), { key: 'End' });
		fireEvent.keyDown(screen.getByTestId('scroller'), { key: 'End', ctrlKey: true });
		expect(onJump).toHaveBeenCalledTimes(2);
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit message' }), { key: 'End' });
		fireEvent.keyDown(screen.getByRole('button', { name: 'Copy' }), { key: 'Home' });
		expect(onJump).toHaveBeenCalledTimes(2);
	});

	it('reads the key and its target', () => {
		const div = document.createElement('div');
		div.setAttribute('contenteditable', 'true');
		expect(isJumpKey({ key: 'End', target: div })).toBe(false);
		expect(isJumpKey({ key: 'End', target: null })).toBe(true);
		expect(isJumpKey({ key: 'PageDown', target: null })).toBe(false);
	});
});
