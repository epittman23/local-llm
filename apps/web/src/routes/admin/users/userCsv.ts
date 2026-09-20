export type UserCsvRow = { idx: number; columns: string[] };

/**
 * The Add User CSV rules from AddUserModal.svelte: a header row (skipped), then
 * exactly four columns -- Name, Email, Password, Role -- with the role one of
 * admin/user/pending. Invalid rows are reported by index (0 = header) so the
 * caller can say "Row N" the way the original does; `idx` is kept 0-based to
 * match its `Row ${idx + 1}` wording. Blank lines are skipped.
 */
export function parseUserCsv(csv: string): { validRows: UserCsvRow[]; invalidRows: number[] } {
	const validRows: UserCsvRow[] = [];
	const invalidRows: number[] = [];
	csv
		.split('\n')
		.forEach((row, idx) => {
			// A blank line (the file's trailing newline, usually) is not a bad row; the
			// Svelte importer reports it as one, which every well-formed CSV trips.
			if (idx === 0 || row.trim() === '') return;
			const columns = row.split(',').map((col) => col.trim());
			if (columns.length === 4 && ['admin', 'user', 'pending'].includes(columns[3].toLowerCase())) {
				validRows.push({ idx, columns });
			} else {
				invalidRows.push(idx);
			}
		});
	return { validRows, invalidRows };
}
