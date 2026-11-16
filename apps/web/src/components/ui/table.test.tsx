import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Table, TableBody, TableCell, TableHeader, TableRow, TableSortHead } from '@/components/ui/table';

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

describe('a row that opens something (DAT-6, NAV-5)', () => {
	function OpeningRow({ onOpen, onMenu }: { onOpen: () => void; onMenu?: () => void }) {
		return (
			<Table>
				<TableBody>
					<TableRow onOpen={onOpen}>
						<TableCell>
							<button type="button" onClick={onOpen}>
								demo-a
							</button>
						</TableCell>
						<TableCell>12.5</TableCell>
						<TableCell>
							<button type="button" onClick={onMenu}>
								More
							</button>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
	}

	it('opens on a click anywhere on the row, once from its name button, and not from another control', () => {
		const onOpen = vi.fn();
		const onMenu = vi.fn();
		render(<OpeningRow onOpen={onOpen} onMenu={onMenu} />);
		const row = screen.getByRole('row');
		expect(row).toHaveAttribute('data-opens');
		expect(row).toHaveClass('cursor-pointer');
		fireEvent.click(screen.getByText('12.5'));
		expect(onOpen).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('button', { name: 'demo-a' }));
		expect(onOpen).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole('button', { name: 'More' }));
		expect(onOpen).toHaveBeenCalledTimes(2);
		expect(onMenu).toHaveBeenCalledTimes(1);
	});

	it('is reached and opened from the keyboard through its name button', () => {
		const onOpen = vi.fn();
		render(<OpeningRow onOpen={onOpen} />);
		const name = screen.getByRole('button', { name: 'demo-a' });
		name.focus();
		expect(document.activeElement).toBe(name);
		// A button's Enter is its click.
		fireEvent.click(name);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('leaves a plain row alone, and lets a caller’s own click stop the open', () => {
		const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
		const onOpen = vi.fn();
		render(
			<Table>
				<TableBody>
					<TableRow>
						<TableCell>plain</TableCell>
					</TableRow>
					<TableRow onOpen={onOpen} onClick={onClick}>
						<TableCell>stopped</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
		expect(screen.getAllByRole('row')[0]).not.toHaveAttribute('data-opens');
		expect(screen.getAllByRole('row')[0]).not.toHaveClass('cursor-pointer');
		fireEvent.click(screen.getByText('stopped'));
		expect(onClick).toHaveBeenCalled();
		expect(onOpen).not.toHaveBeenCalled();
	});
});

describe('a sortable column heading (DAT-6)', () => {
	function Head({ active, direction, onSort }: { active: boolean; direction: 'asc' | 'desc'; onSort: () => void }) {
		return (
			<Table>
				<TableHeader>
					<TableRow>
						<TableSortHead label="Rating" active={active} direction={direction} onSort={onSort} className="w-20" />
					</TableRow>
				</TableHeader>
			</Table>
		);
	}

	it('names the open sort and its way in aria-sort, on that heading only', () => {
		const onSort = vi.fn();
		const { rerender } = render(<Head active direction="desc" onSort={onSort} />);
		const head = screen.getByRole('columnheader', { name: 'Rating' });
		expect(head).toHaveAttribute('aria-sort', 'descending');
		expect(head).toHaveAttribute('scope', 'col');
		expect(head).toHaveClass('w-20');
		fireEvent.click(screen.getByRole('button', { name: 'Rating' }));
		expect(onSort).toHaveBeenCalledTimes(1);
		rerender(<Head active direction="asc" onSort={onSort} />);
		expect(head).toHaveAttribute('aria-sort', 'ascending');
		rerender(<Head active={false} direction="asc" onSort={onSort} />);
		expect(head).not.toHaveAttribute('aria-sort');
	});
});
