import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

function rows() {
	return (
		<TableBody>
			<TableRow>
				<TableCell>demo-a</TableCell>
				<TableCell>12.5</TableCell>
			</TableRow>
		</TableBody>
	);
}

/** happy-dom does no layout: give the scroller the sizes a browser would. */
function sizeScroller(el: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
	Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
	Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

afterEach(() => vi.restoreAllMocks());

describe('Table (DAT-6)', () => {
	it('names its scrolling container as a region when given aria-label, and leaves the table unnamed', () => {
		render(<Table aria-label="Users">{rows()}</Table>);
		const region = screen.getByRole('region', { name: 'Users' });
		expect(region).toHaveAttribute('data-slot', 'table-container');
		expect(screen.getByRole('table')).not.toHaveAttribute('aria-label');
		// Nothing is clipped, so it is no tab stop.
		expect(region).not.toHaveAttribute('tabindex');
	});

	it('is no region without a label', () => {
		render(<Table>{rows()}</Table>);
		expect(screen.queryByRole('region')).toBeNull();
	});

	it('becomes focusable and shows the edge that hides columns once it overflows', () => {
		render(<Table aria-label="Leaderboard">{rows()}</Table>);
		const region = screen.getByRole('region', { name: 'Leaderboard' });
		const frame = region.parentElement as HTMLElement;
		expect(frame).toHaveAttribute('data-slot', 'table-frame');
		expect(frame).not.toHaveAttribute('data-clipped-end');

		sizeScroller(region, { scrollWidth: 673, clientWidth: 362 });
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		expect(region).toHaveAttribute('tabindex', '0');
		expect(frame).toHaveAttribute('data-clipped-end');
		expect(frame).not.toHaveAttribute('data-clipped-start');

		// Scrolled to the far end: only the start is hidden.
		region.scrollLeft = 311;
		fireEvent.scroll(region);
		expect(frame).toHaveAttribute('data-clipped-start');
		expect(frame).not.toHaveAttribute('data-clipped-end');
	});

	it('keeps the first column in view when asked', () => {
		render(
			<Table aria-label="Runs" stickyFirstColumn className="min-w-[38rem]">
				{rows()}
			</Table>
		);
		const table = screen.getByRole('table');
		expect(table).toHaveAttribute('data-sticky-first-column');
		expect(table).toHaveClass('[&_tr>:first-child]:sticky', 'min-w-[38rem]');
	});

	it('stops listening when it unmounts', () => {
		const remove = vi.spyOn(window, 'removeEventListener');
		const { unmount } = render(<Table>{rows()}</Table>);
		unmount();
		expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
	});
});
