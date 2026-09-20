export type GroupCsvRow = { idx: number; email: string };

/**
 * The group-membership CSV rules from Groups/Users.svelte: a header row, then
 * exactly two columns (Name, Email). Rows are identified by email, lowercased;
 * blank lines are ignored and anything else that is not two columns with an
 * email is reported by 1-based line index (`idx` counts the header as 0), the
 * way the original's "Row N" messages do.
 */
export function parseGroupCsv(csv: string): { validRows: GroupCsvRow[]; invalidRows: number[] } {
	const validRows: GroupCsvRow[] = [];
	const invalidRows: number[] = [];
	csv
		.split(/\r?\n/)
		.slice(1)
		.forEach((row, index) => {
			const idx = index + 1;
			const columns = row.split(',').map((col) => col.trim());
			if (columns.length === 1 && columns[0] === '') return;
			const email = columns[1]?.toLowerCase();
			if (columns.length !== 2 || !email) invalidRows.push(idx);
			else validRows.push({ idx, email });
		});
	return { validRows, invalidRows };
}

export const chunk = <T>(items: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
