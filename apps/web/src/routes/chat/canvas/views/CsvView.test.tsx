import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_MAX_CELL, CSV_MAX_COLS, CSV_MAX_ROWS } from '../limits';
import { docOf, id, output, renderWithClient } from '../testing';
import { CsvView } from './CsvView';

const api = vi.hoisted(() => ({
	text: vi.fn<
		(token: string, id: string, max: number, signal?: AbortSignal) => Promise<{ text: string; truncated: boolean }>
	>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputText: api.text, getSandboxOutputHtml: vi.fn() }));

beforeEach(() => {
	api.text.mockReset();
});

describe('CsvView', () => {
	it(`shows a CSV as a table of its first ${CSV_MAX_ROWS} rows, its first row as the header`, async () => {
		const lines = ['name,"note, quoted"', ...Array.from({ length: 300 }, (_, i) => `r${i},"<b>${i}</b>"`)];
		api.text.mockResolvedValue({ text: lines.join('\n'), truncated: false });
		renderWithClient(<CsvView doc={docOf(output('c5', 'results.csv'))} />);
		const table = await screen.findByTestId('canvas-csv');
		expect(
			within(table)
				.getAllByRole('columnheader')
				.map((th) => th.textContent)
		).toEqual(['name', 'note, quoted']);
		const rows = table.querySelectorAll('tr');
		expect(rows).toHaveLength(CSV_MAX_ROWS);
		// Cells are text, never markup.
		expect(rows[1].textContent).toContain('<b>0</b>');
		expect(table.querySelector('b')).toBeNull();
		expect(screen.getByText(`Showing the first ${CSV_MAX_ROWS} rows.`)).toBeInTheDocument();
		expect(screen.queryByText(/Wide rows and long cells are cut/)).toBeNull();
		expect(api.text).toHaveBeenCalledWith('', id('c5'), 1024 * 1024, expect.any(AbortSignal));
	});

	it('caps a CSV’s columns and cell length, and leaves out a row the fetch cut short', async () => {
		const wide = Array.from({ length: CSV_MAX_COLS + 10 }, (_, i) => `c${i}`).join(',');
		api.text.mockResolvedValue({ text: `${wide}\n${'x'.repeat(CSV_MAX_CELL + 5)},2\nhalf a ro`, truncated: true });
		renderWithClient(<CsvView doc={docOf(output('c6', 'wide.csv'))} />);
		const table = await screen.findByTestId('canvas-csv');
		expect(within(table).getAllByRole('columnheader')).toHaveLength(CSV_MAX_COLS);
		const rows = table.querySelectorAll('tbody tr');
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector('td')?.textContent).toHaveLength(CSV_MAX_CELL);
		expect(table).not.toHaveTextContent('half a ro');
		expect(screen.getByText(/Wide rows and long cells are cut/)).toBeInTheDocument();
		expect(screen.getByText('Showing the first 2 rows.')).toBeInTheDocument();
	});

	it('says when a CSV cannot be fetched', async () => {
		api.text.mockRejectedValue({ detail: 'Not found' });
		renderWithClient(<CsvView doc={docOf(output('7', 'log.csv'))} />);
		expect(await screen.findByText(/Could not show this file: Not found/)).toBeInTheDocument();
	});
});
