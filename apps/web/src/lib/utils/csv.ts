// CSV cells for files an admin will open in a spreadsheet. Some of what goes in
// them is written by other users (feedback comments, display names), and a cell
// that starts with = + - @ (or a tab / carriage return) is run as a formula by
// Excel, Sheets and LibreOffice -- CSV/formula injection. The OWASP mitigation is
// to prefix such a cell with a single quote so it is read as text.

const FORMULA_START = /^[=+\-@\t\r]/;
// A plain number is safe as it is, and must stay one: ratings are -1 / 0 / 1.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** A string made inert for a spreadsheet: `=1+1` -> `'=1+1`; numbers and ordinary text are unchanged. */
export const neutralizeFormula = (text: string) =>
	FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;

/**
 * One CSV field: nullish -> empty; text is formula-neutralized, and quoted (with
 * `"` doubled) when it contains a comma, quote or newline. Numbers are written
 * as they are.
 */
export function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = typeof value === 'string' ? neutralizeFormula(value) : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The first `maxRows` records of a CSV text (RFC 4180: quoted fields may hold
 * commas, newlines and doubled quotes; CRLF, LF or CR line ends), and whether
 * more followed. For showing a file, so it is lenient: a stray quote inside an
 * unquoted field is kept as text, and an unterminated quote runs to the end.
 * Every line is a record, a blank one too (a one-column file's empty value);
 * only the end of the text needs no line end. A record keeps at most
 * `maxCols` fields and a field at most `maxCell` characters, so a hostile file
 * (a megabyte of commas) stays a small table; `clipped` says something was cut.
 */
export function parseCsvRows(
	text: string,
	maxRows: number,
	{ maxCols = Number.POSITIVE_INFINITY, maxCell = Number.POSITIVE_INFINITY } = {}
): { rows: string[][]; more: boolean; clipped: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let quotedSeen = false;
	let clipped = false;
	const add = (c: string) => {
		if (field.length < maxCell) field += c;
		else clipped = true;
	};
	const endField = () => {
		if (row.length < maxCols) row.push(field);
		else clipped = true;
		field = '';
		quotedSeen = false;
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				add('"');
				i++;
			} else if (c === '"') quoted = false;
			else add(c);
		} else if (c === '"' && field === '' && !quotedSeen) {
			quoted = true;
			quotedSeen = true;
		} else if (c === ',') endField();
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			endRow();
			if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), more: true, clipped };
		} else add(c);
	}
	if (field !== '' || quotedSeen || row.length) endRow();
	return { rows: rows.slice(0, maxRows), more: rows.length > maxRows, clipped };
}
