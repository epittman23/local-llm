import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/apis/errors';
import type { CanvasDocument } from '@/lib/chat/documents';
import { parseCsvRows } from '@/lib/utils/csv';
import { CSV_MAX_BYTES, CSV_MAX_CELL, CSV_MAX_COLS, CSV_MAX_ROWS } from '../limits';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** A CSV file as the standard's table (CNV-4, DAT-1): its first row the header, its first rows and columns, each cell text. */
export function CsvView({ doc }: { doc: CanvasDocument }) {
	const text = useDocumentText(doc, CSV_MAX_BYTES);
	if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	if (!text.data) return <Loading />;
	const parsed = parseCsvRows(text.data.text, CSV_MAX_ROWS, { maxCols: CSV_MAX_COLS, maxCell: CSV_MAX_CELL });
	// When the fetch stopped at the cap inside the rows shown, the last one is cut short: leave it out.
	const rows = text.data.truncated && !parsed.more ? parsed.rows.slice(0, -1) : parsed.rows;
	// A row's or cell's place is its identity: the table is drawn once per file and never reordered.
	const [head, ...body] = rows.map((cells, at) => ({ at, cells: cells.map((cell, col) => ({ col, cell })) }));
	return (
		<div className="h-full overflow-auto p-3">
			<Table className="text-dense" aria-label={doc.name} data-testid="canvas-csv">
				{head ? (
					<TableHeader>
						<TableRow>
							{head.cells.map(({ col, cell }) => (
								<TableHead key={col} scope="col" className="whitespace-pre-wrap">
									{cell}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
				) : null}
				<TableBody>
					{body.map((row) => (
						<TableRow key={row.at}>
							{row.cells.map(({ col, cell }) => (
								<TableCell key={col} className="whitespace-pre-wrap">
									{cell}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
			{parsed.more || text.data.truncated ? <Note>Showing the first {rows.length} rows.</Note> : null}
			{parsed.clipped ? (
				<Note>
					Wide rows and long cells are cut (at most {CSV_MAX_COLS} columns of {CSV_MAX_CELL} characters).
				</Note>
			) : null}
		</div>
	);
}
