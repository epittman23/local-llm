import { parseCsvRows } from './csv';

/** The most a CSV can have and still be edited as a table (CNV-6): the viewer shows no more of a cell or a row than this. */
export const CSV_TABLE_MAX_ROWS = 500;
export const CSV_TABLE_MAX_COLS = 50;
export const CSV_TABLE_MAX_CELL = 1000;

/**
 * A CSV file as an editable table, with what it takes to write the same file
 * back: the line ending, whether the text ends with one, and a byte order
 * mark. Rows are padded to the widest row (`ragged` says some were short).
 */
export type CsvTable = {
	rows: string[][];
	eol: '\n' | '\r\n';
	trailingNewline: boolean;
	bom: boolean;
	ragged: boolean;
};

/**
 * Why a file is not edited as a table: `size` (too many rows or columns, or a
 * cell the viewer would cut), `delimiter` (separated by a semicolon or a tab:
 * comma is the only one written), `roundtrip` (writing it back would change
 * more than its quoting, e.g. mixed line endings).
 */
export type CsvNotFaithful = 'size' | 'delimiter' | 'roundtrip';

export type CsvTableParse = { table: CsvTable } | { notFaithful: CsvNotFaithful };

type Scan = { rows: string[][]; eol: CsvTable['eol']; trailingNewline: boolean; bom: boolean; mixedEol: boolean };

/** The records of a text and its line ending as `parseCsvRows` reads them (a quote opens only at a field's start). */
function scan(input: string): Scan {
	const bom = input.startsWith('\uFEFF');
	const text = bom ? input.slice(1) : input;
	const kinds = new Set<string>();
	let quoted = false;
	let fieldStart = true;
	let lastWasEol = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		lastWasEol = false;
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') i++;
			else if (c === '"') quoted = false;
		} else if (c === '"' && fieldStart) {
			quoted = true;
			fieldStart = false;
		} else if (c === ',') fieldStart = true;
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') {
				kinds.add('\r\n');
				i++;
			} else kinds.add(c);
			fieldStart = true;
			lastWasEol = true;
		} else fieldStart = false;
	}
	const { rows } = parseCsvRows(text, Number.POSITIVE_INFINITY);
	const first = [...kinds][0];
	return {
		rows,
		eol: first === '\r\n' ? '\r\n' : '\n',
		trailingNewline: lastWasEol,
		bom,
		mixedEol: kinds.size > 1 || first === '\r'
	};
}

/**
 * Quoting by RFC 4180 and nothing else: a cell is quoted when it holds a comma,
 * a quote, a CR or LF, or begins or ends with a space. It is deliberately NOT
 * `csvCell` (utils/csv.ts), which prefixes a quote to a cell starting with
 * = + - @ so a report opens safely in a spreadsheet: here that would rewrite
 * a person's `=SUM(A1:A3)` into `'=SUM(A1:A3)`. The text is only stored and
 * returned; nothing in the app evaluates a cell.
 */
const writeCell = (cell: string) => (/[",\r\n]|^ | $/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** The table as text, in the line ending and with the final newline it was read with. */
export function stringifyCsvTable({
	rows,
	eol,
	trailingNewline,
	bom
}: Omit<CsvTable, 'ragged'> & { ragged?: boolean }): string {
	const last = rows.length - 1;
	const lines = rows.map((row, at) => {
		// A one-column row with nothing in it is a blank line, which at the very end of a text would be lost.
		if (at === last && !trailingNewline && row.length === 1 && row[0] === '') return '""';
		return row.map(writeCell).join(',');
	});
	return (bom ? '\uFEFF' : '') + lines.join(eol) + (trailingNewline && lines.length ? eol : '');
}

const sameRows = (a: string[][], b: string[][]) =>
	a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((cell, j) => cell === b[i][j]));

/**
 * The text as a table, or why it cannot be edited as one. A table is offered
 * only when nothing in it is cut (500 rows, 50 columns, 1,000 characters a
 * cell) and when writing it back gives the same records, line ending, final
 * newline and byte order mark: quoting may change, nothing else.
 */
export function parseCsvTable(text: string): CsvTableParse {
	const { rows, mixedEol, ...rest } = scan(text);
	if (rows.length > 0 && rows.every((row) => row.length === 1) && /[;\t]/.test(rows[0][0]))
		return { notFaithful: 'delimiter' };
	const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
	if (
		rows.length > CSV_TABLE_MAX_ROWS ||
		width > CSV_TABLE_MAX_COLS ||
		rows.some((row) => row.some((cell) => cell.length > CSV_TABLE_MAX_CELL))
	)
		return { notFaithful: 'size' };
	if (mixedEol) return { notFaithful: 'roundtrip' };
	const again = scan(stringifyCsvTable({ rows, ...rest }));
	if (!sameRows(again.rows, rows) || again.eol !== rest.eol || again.trailingNewline !== rest.trailingNewline)
		return { notFaithful: 'roundtrip' };
	const ragged = rows.some((row) => row.length !== width);
	return {
		table: {
			...rest,
			ragged,
			rows: rows.map((row) => (row.length === width ? row : [...row, ...Array(width - row.length).fill('')]))
		}
	};
}
