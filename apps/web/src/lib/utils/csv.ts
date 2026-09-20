// CSV cells for files an admin will open in a spreadsheet. Some of what goes in
// them is written by other users (feedback comments, display names), and a cell
// that starts with = + - @ (or a tab / carriage return) is run as a formula by
// Excel, Sheets and LibreOffice -- CSV/formula injection. The OWASP mitigation is
// to prefix such a cell with a single quote so it is read as text.

const FORMULA_START = /^[=+\-@\t\r]/;
// A plain number is safe as it is, and must stay one: ratings are -1 / 0 / 1.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** A string made inert for a spreadsheet: `=1+1` -> `'=1+1`; numbers and ordinary text are unchanged. */
export const neutralizeFormula = (text: string) => (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text);

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
