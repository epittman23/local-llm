import {
	type ColumnDef,
	createSortedRowModel,
	flexRender,
	rowSortingFeature,
	type SortingState,
	sortFn_alphanumeric,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
	useTable
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHeader, TableRow, TableSortHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { type ColumnSpec, columnSpec, formatCell, isNumericKind, sortValue } from './compareFormat';
import { OutcomeBadge } from './OutcomeBadge';

// TanStack Table v9 bundles only the features a table declares. Sorting is
// the only one this table uses; the three sort functions are the ones v9's
// 'auto' sort picks between (anything else sorts with its built-in `basic`),
// which keeps v8's automatic per-column sorting.
const features = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, datetime: sortFn_datetime, text: sortFn_text }
});

/** The columns worth showing, the configuration first: `alias` only where it says something `model` does not. */
function shownColumns(columns: string[], rows: Record<string, unknown>[]): string[] {
	const aliasRepeatsModel =
		columns.includes('alias') && columns.includes('model') && rows.every((row) => row.alias === row.model);
	const shown = aliasRepeatsModel ? columns.filter((col) => col !== 'alias') : columns;
	// The configuration is what a row is about, so it comes first, where it stays in view.
	return shown.includes('config_id') ? ['config_id', ...shown.filter((col) => col !== 'config_id')] : shown;
}

/**
 * The Compare page's generic sortable table: whatever columns the backend
 * sent, in the order it sent them, under words with their unit (DAT-2) and in
 * one format per column, figures right-aligned. Used by the benchmark,
 * failures and serving views, whose shapes are plain rows; the config view
 * has its own per-block rendering (CompareBlocks). The first column stays in
 * view while the rest scroll sideways, and with `stickyHeader` the headings
 * stay in view while a long list scrolls (LAY-7).
 */
export function CompareDataTable({
	label,
	columns,
	rows,
	stickyHeader = false
}: {
	/** The table's name, for its scrolling region (DAT-6). */
	label: string;
	columns: string[];
	rows: Record<string, unknown>[];
	stickyHeader?: boolean;
}) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const specs = useMemo(
		() =>
			new Map<string, ColumnSpec>(
				shownColumns(columns, rows).map((col) => [
					col,
					columnSpec(
						col,
						rows.map((row) => row[col])
					)
				])
			),
		[columns, rows]
	);
	const columnDefs = useMemo<ColumnDef<typeof features, Record<string, unknown>>[]>(
		() =>
			[...specs].map(([col, spec]) => {
				return {
					id: col,
					header: spec.label,
					accessorFn: (row) => sortValue(row[col], spec.kind),
					cell: (info) => {
						const value = info.row.original[col];
						if (col === 'outcome' && typeof value === 'string' && value) return <OutcomeBadge outcome={value} />;
						return formatCell(value, col, spec);
					}
				};
			}),
		[specs]
	);
	const table = useTable({
		features,
		data: rows,
		columns: columnDefs,
		state: { sorting },
		onSortingChange: setSorting
	});
	const kindOf = (col: string) => specs.get(col)?.kind ?? 'text';

	return (
		<Table aria-label={label} stickyFirstColumn stickyHeader={stickyHeader}>
			<TableHeader>
				{table.getHeaderGroups().map((headerGroup) => (
					<TableRow key={headerGroup.id}>
						{headerGroup.headers.map((header) => {
							const numeric = isNumericKind(kindOf(header.column.id));
							const sorted = header.column.getIsSorted();
							return (
								<TableSortHead
									key={header.id}
									label={specs.get(header.column.id)?.label ?? header.column.id}
									active={sorted !== false}
									direction={sorted === 'asc' ? 'asc' : 'desc'}
									onSort={() => header.column.toggleSorting()}
									className={cn(numeric && 'text-right')}
									buttonClassName={cn(numeric && 'justify-end')}
								/>
							);
						})}
					</TableRow>
				))}
			</TableHeader>
			<TableBody>
				{table.getRowModel().rows.map((row) => (
					<TableRow key={row.id}>
						{row.getAllCells().map((cell) => {
							const kind = kindOf(cell.column.id);
							return (
								<TableCell
									key={cell.id}
									className={cn(
										isNumericKind(kind) && 'text-right',
										kind === 'id' && 'font-mono',
										cell.column.id === 'reason' && 'min-w-64 whitespace-normal'
									)}
								>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</TableCell>
							);
						})}
					</TableRow>
				))}
				{rows.length === 0 && (
					<TableRow>
						<TableCell colSpan={Math.max(columns.length, 1)} className="text-muted-foreground text-center">
							Nothing recorded for this view yet
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);
}
