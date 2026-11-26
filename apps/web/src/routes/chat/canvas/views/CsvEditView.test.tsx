import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docOf, output, renderWithClient } from '../testing';
import { CsvEditView } from './CsvEditView';

const START = 'name,qty\nAda,3\nBo,4\n';

let draftNow = START;
const onSave = vi.fn();

function Harness({
	start = START,
	dirty = false,
	rewrites = false
}: {
	start?: string;
	dirty?: boolean;
	rewrites?: boolean;
}) {
	const [draft, setDraft] = useState(start);
	draftNow = draft;
	return (
		<CsvEditView
			doc={docOf(output('1', 'table.csv'))}
			edit={{ draft, setDraft, inputRef: { current: null }, onSave }}
			extras={{ cellRef: { current: null }, dirty, rewrites }}
		/>
	);
}

const cell = (row: number, col: number) =>
	screen.getByRole('textbox', {
		name: row === 0 ? `Heading of column ${col + 1}` : `Row ${row}, column ${col + 1}`
	}) as HTMLTextAreaElement;
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const press = (box: HTMLElement, key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box, { key, ...init });
async function pick(trigger: string, item: string) {
	fireEvent.pointerDown(screen.getByRole('button', { name: trigger }), { button: 0, pointerType: 'mouse' });
	fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

afterEach(() => {
	cleanup();
	draftNow = START;
	onSave.mockReset();
});

describe('CsvEditView', () => {
	it('shows the headings and the cells as fields', () => {
		renderWithClient(<Harness />);
		expect(cell(0, 0)).toHaveValue('name');
		expect(cell(1, 1)).toHaveValue('3');
		expect(cell(2, 0)).toHaveValue('Bo');
		expect(screen.getAllByRole('columnheader')).toHaveLength(3);
	});

	it('writes an edited cell to the draft as text, and the unedited file is left as it was', () => {
		renderWithClient(<Harness />);
		expect(draftNow).toBe(START);
		type(cell(1, 0), 'Ada L');
		expect(draftNow).toBe('name,qty\nAda L,3\nBo,4\n');
		type(cell(1, 0), 'Ada');
		expect(draftNow).toBe(START);
	});

	it('writes quoting a cell needs, and a formula-like cell as typed', () => {
		renderWithClient(<Harness />);
		type(cell(1, 0), 'a, "b"');
		type(cell(2, 1), '=SUM(A1:A3)');
		type(cell(2, 0), '-5');
		expect(draftNow).toBe('name,qty\n"a, ""b""",3\n-5,=SUM(A1:A3)\n');
	});

	it('inserts a row below and deletes a row', () => {
		renderWithClient(<Harness />);
		fireEvent.click(screen.getByRole('button', { name: 'Insert row below row 1' }));
		expect(draftNow).toBe('name,qty\nAda,3\n,\nBo,4\n');
		expect(cell(2, 0)).toHaveFocus();
		fireEvent.click(screen.getByRole('button', { name: 'Delete row 1' }));
		expect(draftNow).toBe('name,qty\n,\nBo,4\n');
		fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
		expect(draftNow).toBe('name,qty\n,\nBo,4\n,\n');
	});

	it('adds and deletes a column from the heading menu', async () => {
		renderWithClient(<Harness />);
		await pick('Column 1 actions', 'Add column after');
		expect(draftNow).toBe('name,,qty\nAda,,3\nBo,,4\n');
		await pick('Column 3 actions', 'Delete column');
		expect(draftNow).toBe('name,\nAda,\nBo,\n');
	});

	it('does not offer to delete the last column', async () => {
		renderWithClient(<Harness start={'a\n1\n'} />);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Column 1 actions' }), {
			button: 0,
			pointerType: 'mouse'
		});
		expect(await screen.findByRole('menuitem', { name: 'Delete column' })).toHaveAttribute('aria-disabled', 'true');
	});

	it('has no row to delete for the heading, and every control has a name', () => {
		renderWithClient(<Harness />);
		expect(screen.queryByRole('button', { name: 'Delete row 0' })).toBeNull();
		for (const button of screen.getAllByRole('button')) expect(button, button.outerHTML).toHaveAccessibleName();
		for (const box of screen.getAllByRole('textbox')) expect(box, box.outerHTML).toHaveAccessibleName();
	});

	it('moves with Enter down and Shift+Enter up, and Tab is left to the browser', () => {
		renderWithClient(<Harness />);
		press(cell(0, 1), 'Enter');
		expect(cell(1, 1)).toHaveFocus();
		press(cell(1, 1), 'Enter');
		expect(cell(2, 1)).toHaveFocus();
		press(cell(2, 1), 'Enter');
		expect(cell(2, 1)).toHaveFocus();
		press(cell(2, 1), 'Enter', { shiftKey: true });
		expect(cell(1, 1)).toHaveFocus();
		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		cell(1, 1).dispatchEvent(tab);
		expect(tab.defaultPrevented).toBe(false);
	});

	it('does not move on Enter while an input method is composing', () => {
		renderWithClient(<Harness />);
		cell(0, 0).focus();
		fireEvent.keyDown(cell(0, 0), { key: 'Enter', isComposing: true });
		expect(cell(0, 0)).toHaveFocus();
	});

	it('keeps a multi-line cell, and Alt+Enter adds a line break at the caret', () => {
		renderWithClient(<Harness start={'a,b\n"two\nlines",x\n'} />);
		expect(cell(1, 0)).toHaveValue('two\nlines');
		const box = cell(1, 1);
		type(box, 'xy');
		box.setSelectionRange(1, 1);
		press(box, 'Enter', { altKey: true });
		expect(cell(1, 1)).toHaveValue('x\ny');
		expect(draftNow).toBe('a,b\n"two\nlines","x\ny"\n');
	});

	it('Ctrl+S saves', () => {
		renderWithClient(<Harness />);
		press(cell(1, 0), 's', { ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it('shows cell text as a value and never as markup', () => {
		const { container } = renderWithClient(<Harness start={'<b>x</b>,<img src=x onerror=alert(1)>\n1,2\n'} />);
		expect(cell(0, 0)).toHaveValue('<b>x</b>');
		expect(container.querySelector('b, img')).toBeNull();
	});

	it('starts an empty file with an Add row that makes the first row', () => {
		renderWithClient(<Harness start="" />);
		expect(screen.queryByRole('table')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
		expect(draftNow).toBe('""');
		expect(cell(0, 0)).toHaveFocus();
	});

	it('stops adding rows at 500 and says why', () => {
		const rows = Array.from({ length: 500 }, (_, i) => `${i}`).join('\n');
		renderWithClient(<Harness start={rows} />);
		expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled();
		expect(screen.getByText('A table has at most 500 rows.')).toBeInTheDocument();
	});

	it('says what saving does to quoting and to short rows, once there is a change', () => {
		renderWithClient(<Harness start={'a,b\n1\n'} rewrites />);
		expect(screen.queryByText(/Saving/)).toBeNull();
		cleanup();
		renderWithClient(<Harness start={'a,b\n1\n'} rewrites dirty />);
		expect(screen.getByText('Saving pads short rows with empty cells and normalises quoting.')).toBeInTheDocument();
		cleanup();
		renderWithClient(<Harness rewrites dirty />);
		expect(screen.getByText('Saving normalises quoting.')).toBeInTheDocument();
		cleanup();
		renderWithClient(<Harness dirty />);
		expect(screen.queryByText(/Saving/)).toBeNull();
	});

	it('offers the text instead of a table that is not faithful', () => {
		renderWithClient(<Harness start={'a;b\n1;2\n'} />);
		expect(screen.getByText(/Only comma-separated files/)).toBeInTheDocument();
		expect(within(document.body).queryByRole('table')).toBeNull();
	});
});
