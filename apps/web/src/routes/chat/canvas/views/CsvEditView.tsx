import { EllipsisIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type KeyboardEvent, memo, type RefObject, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type { CanvasDocument } from '@/lib/chat/documents';
import {
	CSV_TABLE_MAX_CELL,
	CSV_TABLE_MAX_COLS,
	CSV_TABLE_MAX_ROWS,
	parseCsvTable,
	stringifyCsvTable
} from '@/lib/utils/csvTable';
import { tableNote } from '../present';
import { Note } from './parts';
import type { SourceEdit } from './SourceView';

/** What `CsvEditView` needs beyond the draft: where the first cell goes, and what the table says about saving. */
export type CsvEditExtras = {
	/** The first cell, which takes focus when editing starts. */
	cellRef: RefObject<HTMLElement | null>;
	/** A cell changed: the draft differs from the text it started from. */
	dirty: boolean;
	/** The file is written differently from how it was read (quoting); saying so is the Note's job. */
	rewrites: boolean;
};

type Row = { key: number; cells: string[] };

const cellIn = (root: HTMLElement | null, row: number, col: number) =>
	root?.querySelector<HTMLTextAreaElement>(`[data-row="${row}"][data-col="${col}"]`) ?? null;

const HINT = 'Tab moves to the next cell. Enter moves down and Shift+Enter up. Alt+Enter adds a line break in a cell.';

/** One row: it re-renders only when its own cells change, so a keystroke does not redraw 500 rows. */
const TableLine = memo(function TableLine({
	row,
	cols,
	at,
	canInsert,
	onCell,
	onKeyDown,
	onInsert,
	onDelete
}: {
	row: Row;
	/** The columns' own keys, in order. */
	cols: number[];
	/** Index in the table, the heading row being 0. */
	at: number;
	canInsert: boolean;
	onCell: (at: number, col: number, value: string) => void;
	onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, at: number, col: number) => void;
	onInsert: (at: number) => void;
	onDelete: (at: number) => void;
}) {
	return (
		<TableRow>
			{row.cells.map((cell, col) => (
				<TableCell key={`${row.key}:${cols[col]}`} className="min-w-28 p-0 align-top">
					<Textarea
						rows={1}
						value={cell}
						maxLength={CSV_TABLE_MAX_CELL}
						aria-label={`Row ${at}, column ${col + 1}`}
						data-row={at}
						data-col={col}
						className="min-h-0 resize-none rounded-none border-0 px-2 py-1 tabular-nums"
						onChange={(e) => onCell(at, col, e.target.value)}
						onKeyDown={(e) => onKeyDown(e, at, col)}
					/>
				</TableCell>
			))}
			<TableCell className="w-0 p-0 align-top">
				<div className="flex gap-0.5 px-1 py-0.5">
					<Tip content="Insert row below">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`Insert row below row ${at}`}
							disabled={!canInsert}
							onClick={() => onInsert(at)}
						>
							<PlusIcon aria-hidden />
						</Button>
					</Tip>
					<Tip content="Delete row">
						<Button variant="ghost" size="icon-xs" aria-label={`Delete row ${at}`} onClick={() => onDelete(at)}>
							<Trash2Icon aria-hidden />
						</Button>
					</Tip>
				</div>
			</TableCell>
		</TableRow>
	);
});

/**
 * A CSV file being edited as a table (CNV-6, DAT-1): the standard's table with a
 * field in every cell, the first row the headings. Every change is written to
 * the draft as text, so the Save bar, the unsaved-changes guard and the new version
 * are the editor's own; this view keeps the rows, and the draft follows them.
 * Rows and columns are added and removed with named buttons (ACT-4). Tab moves
 * from cell to cell; Enter moves down, Shift+Enter up, Alt+Enter is a line
 * break in the cell, and Ctrl or Cmd+S saves. Cell text is only ever a field's
 * value, never markup. It is only offered for a table `parseCsvTable` calls
 * faithful: at most 500 rows, 50 columns and 1,000 characters a cell.
 */
export function CsvEditView({ doc, edit, extras }: { doc: CanvasDocument; edit: SourceEdit; extras: CsvEditExtras }) {
	const hintId = useId();
	const [start] = useState(() => parseCsvTable(edit.draft));
	const next = useRef(0);
	const rowsRef = useRef<Row[]>([]);
	const colsRef = useRef<number[]>([]);
	const [cols, setCols] = useState<number[]>(() => {
		if ('table' in start) colsRef.current = (start.table.rows[0] ?? []).map(() => next.current++);
		return colsRef.current;
	});
	const [rows, setRows] = useState<Row[]>(() => {
		if (!('table' in start)) return [];
		rowsRef.current = start.table.rows.map((cells) => ({ key: next.current++, cells }));
		return rowsRef.current;
	});
	const tableRef = useRef<HTMLDivElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const [focus, setFocus] = useState<{ row: number; col: number; caret?: number } | null>(null);
	const { setDraft, onSave } = edit;

	const commit = useCallback(
		(changed: Row[], to?: { row: number; col: number; caret?: number }, columns?: number[]) => {
			if (!('table' in start)) return;
			const { eol, trailingNewline, bom } = start.table;
			rowsRef.current = changed;
			setRows(changed);
			if (columns) {
				colsRef.current = columns;
				setCols(columns);
			}
			setDraft(stringifyCsvTable({ rows: changed.map((r) => r.cells), eol, trailingNewline, bom }));
			if (to) setFocus(to);
		},
		[start, setDraft]
	);
	useLayoutEffect(() => {
		if (!focus) return;
		const el = cellIn(tableRef.current, focus.row, focus.col);
		if (el) {
			el.focus();
			if (focus.caret !== undefined) el.setSelectionRange(focus.caret, focus.caret);
		} else addRef.current?.focus();
		setFocus(null);
	}, [focus]);

	const onCell = useCallback(
		(at: number, col: number, value: string) =>
			commit(rowsRef.current.map((r, i) => (i === at ? { ...r, cells: r.cells.with(col, value) } : r))),
		[commit]
	);
	const insertRow = useCallback(
		(at: number) => {
			const current = rowsRef.current;
			if (current.length >= CSV_TABLE_MAX_ROWS) return;
			const cells = Array<string>(current[0]?.cells.length ?? 1).fill('');
			commit(
				current.toSpliced(at + 1, 0, { key: next.current++, cells }),
				{ row: at + 1, col: 0 },
				colsRef.current.length ? undefined : [next.current++]
			);
		},
		[commit]
	);
	const deleteRow = useCallback(
		(at: number) => {
			const changed = rowsRef.current.toSpliced(at, 1);
			commit(changed, { row: Math.min(at, changed.length - 1), col: 0 });
		},
		[commit]
	);
	const insertColumn = (col: number) => {
		if ((rowsRef.current[0]?.cells.length ?? 0) >= CSV_TABLE_MAX_COLS) return;
		commit(
			rowsRef.current.map((r) => ({ ...r, cells: r.cells.toSpliced(col + 1, 0, '') })),
			{ row: 0, col: col + 1 },
			colsRef.current.toSpliced(col + 1, 0, next.current++)
		);
	};
	const deleteColumn = (col: number) => {
		const width = rowsRef.current[0]?.cells.length ?? 0;
		if (width <= 1) return;
		commit(
			rowsRef.current.map((r) => ({ ...r, cells: r.cells.toSpliced(col, 1) })),
			{ row: 0, col: Math.min(col, width - 2) },
			colsRef.current.toSpliced(col, 1)
		);
	};
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>, at: number, col: number) => {
			if (event.nativeEvent.isComposing) return;
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
				event.preventDefault();
				onSave();
			} else if (event.key === 'Enter') {
				event.preventDefault();
				if (event.altKey) {
					const el = event.currentTarget;
					if (el.value.length >= CSV_TABLE_MAX_CELL) return;
					const { selectionStart: from, selectionEnd: to } = el;
					commit(
						rowsRef.current.map((r, i) =>
							i === at ? { ...r, cells: r.cells.with(col, `${el.value.slice(0, from)}\n${el.value.slice(to)}`) } : r
						),
						{ row: at, col, caret: from + 1 }
					);
				} else cellIn(tableRef.current, at + (event.shiftKey ? -1 : 1), col)?.focus();
			}
		},
		[commit, onSave]
	);

	if (!('table' in start))
		return (
			<div className="h-full overflow-auto">
				<Note>{tableNote(start.notFaithful)}</Note>
			</div>
		);
	const { ragged } = start.table;
	const [head, ...body] = rows;
	const width = head?.cells.length ?? 0;
	const full = rows.length >= CSV_TABLE_MAX_ROWS;
	return (
		<div className="h-full overflow-auto p-3">
			{head ? (
				<div ref={tableRef}>
					<Table className="text-dense" aria-label={doc.name} aria-describedby={hintId} data-testid="canvas-csv-edit">
						<TableHeader>
							<TableRow>
								{head.cells.map((cell, col) => (
									<TableHead key={cols[col]} scope="col" className="h-auto min-w-28 p-0 align-top">
										<div className="flex items-start">
											<Textarea
												rows={1}
												value={cell}
												maxLength={CSV_TABLE_MAX_CELL}
												aria-label={`Heading of column ${col + 1}`}
												data-row={0}
												data-col={col}
												ref={
													col === 0
														? (el) => {
																extras.cellRef.current = el;
															}
														: undefined
												}
												className="font-strong min-h-0 min-w-0 flex-1 resize-none rounded-none border-0 px-2 py-1"
												onChange={(e) => onCell(0, col, e.target.value)}
												onKeyDown={(e) => onKeyDown(e, 0, col)}
											/>
											<DropdownMenu>
												<Tip content={`Column ${col + 1} actions`}>
													<DropdownMenuTrigger asChild>
														<Button variant="ghost" size="icon-xs" aria-label={`Column ${col + 1} actions`}>
															<EllipsisIcon aria-hidden />
														</Button>
													</DropdownMenuTrigger>
												</Tip>
												<DropdownMenuContent align="end">
													<DropdownMenuItem disabled={width >= CSV_TABLE_MAX_COLS} onSelect={() => insertColumn(col)}>
														<PlusIcon aria-hidden />
														Add column after
													</DropdownMenuItem>
													<DropdownMenuItem disabled={width <= 1} onSelect={() => deleteColumn(col)}>
														<Trash2Icon aria-hidden />
														Delete column
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									</TableHead>
								))}
								<TableHead scope="col" className="w-0 p-0">
									<span className="sr-only">Row actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{body.map((row, i) => (
								<TableLine
									key={row.key}
									row={row}
									cols={cols}
									at={i + 1}
									canInsert={!full}
									onCell={onCell}
									onKeyDown={onKeyDown}
									onInsert={insertRow}
									onDelete={deleteRow}
								/>
							))}
						</TableBody>
					</Table>
				</div>
			) : null}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button ref={addRef} variant="outline" size="xs" disabled={full} onClick={() => insertRow(rows.length - 1)}>
					<PlusIcon aria-hidden />
					Add row
				</Button>
				{full ? (
					<span className="text-foreground-muted text-dense">A table has at most {CSV_TABLE_MAX_ROWS} rows.</span>
				) : null}
			</div>
			<p id={hintId} className="text-foreground-muted text-dense mt-2">
				{HINT}
			</p>
			{extras.dirty && ragged ? (
				<p className="text-foreground-muted text-dense mt-1">
					Saving pads short rows with empty cells and normalises quoting.
				</p>
			) : null}
			{extras.dirty && !ragged && extras.rewrites ? (
				<p className="text-foreground-muted text-dense mt-1">Saving normalises quoting.</p>
			) : null}
		</div>
	);
}
