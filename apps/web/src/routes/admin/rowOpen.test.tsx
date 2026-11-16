import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { openRow } from './rowOpen';

const renderRow = (open: () => void) =>
	render(
		<table>
			<tbody>
				<tr onClick={openRow(open)}>
					<td>Plain cell</td>
					<td>
						<button type="button">Menu</button>
						{createPortal(
							<div role="menuitem" tabIndex={-1}>
								Delete
							</div>,
							document.body
						)}
					</td>
				</tr>
			</tbody>
		</table>
	);

describe('openRow', () => {
	it('opens from a plain cell', () => {
		const open = vi.fn();
		renderRow(open);
		fireEvent.click(screen.getByText('Plain cell'));
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('leaves a click on a control in the row, or in its portalled menu, to that control', () => {
		const open = vi.fn();
		renderRow(open);
		fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
		expect(open).not.toHaveBeenCalled();
	});
});
