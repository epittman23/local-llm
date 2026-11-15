import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DropOverlay, isFileDrag, useFileDrag } from './DropOverlay';

function Column() {
	const drag = useFileDrag();
	return (
		<section
			aria-label="Chat"
			data-testid="column"
			onDragEnter={drag.onDragEnter}
			onDragLeave={drag.onDragLeave}
			onDrop={drag.onDrop}
		>
			<p data-testid="child">Messages</p>
			<DropOverlay shown={drag.dragging} />
		</section>
	);
}

/** A drag event carrying `types`, as a file drag from the desktop does ('Files') or a text drag does. */
function drag(el: Element, type: 'dragEnter' | 'dragLeave' | 'drop', types: string[]) {
	const event = createEvent[type](el);
	Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } });
	fireEvent(el, event);
}

afterEach(cleanup);

describe('DropOverlay', () => {
	it('says what a drop does while files are dragged over the chat, through its children (#1084)', () => {
		render(<Column />);
		const column = screen.getByTestId('column');
		drag(column, 'dragEnter', ['Files']);
		const overlay = screen.getByTestId('drop-overlay');
		expect(overlay.textContent).toBe('Drop files to attach them to your message');
		expect(overlay.className).toContain('border-dashed');
		expect(overlay.className).toContain('border-border-control');
		expect(overlay.className).toContain('bg-surface-1');
		// The drop still reaches the column underneath.
		expect(overlay.className).toContain('pointer-events-none');

		// Moving onto a child enters it before leaving the column: still over the chat.
		drag(screen.getByTestId('child'), 'dragEnter', ['Files']);
		drag(column, 'dragLeave', ['Files']);
		expect(screen.getByTestId('drop-overlay')).toBeInTheDocument();
		drag(screen.getByTestId('child'), 'dragLeave', ['Files']);
		expect(screen.queryByTestId('drop-overlay')).toBeNull();
	});

	it('shows nothing for a drag that carries no files', () => {
		render(<Column />);
		drag(screen.getByTestId('column'), 'dragEnter', ['text/plain']);
		expect(screen.queryByTestId('drop-overlay')).toBeNull();
		drag(screen.getByTestId('column'), 'dragLeave', ['text/plain']);
		expect(screen.queryByTestId('drop-overlay')).toBeNull();
	});

	it('goes away on a drop, and when a drag ends or drops anywhere else', () => {
		render(<Column />);
		const column = screen.getByTestId('column');
		drag(column, 'dragEnter', ['Files']);
		drag(column, 'drop', ['Files']);
		expect(screen.queryByTestId('drop-overlay')).toBeNull();

		drag(column, 'dragEnter', ['Files']);
		act(() => {
			window.dispatchEvent(new Event('dragend'));
		});
		expect(screen.queryByTestId('drop-overlay')).toBeNull();
		drag(column, 'dragEnter', ['Files']);
		act(() => {
			window.dispatchEvent(new Event('drop'));
		});
		expect(screen.queryByTestId('drop-overlay')).toBeNull();
	});

	it('tells a file drag from others', () => {
		expect(isFileDrag(null)).toBe(false);
		expect(isFileDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
		expect(isFileDrag({ types: ['text/uri-list'] } as unknown as DataTransfer)).toBe(false);
	});
});
