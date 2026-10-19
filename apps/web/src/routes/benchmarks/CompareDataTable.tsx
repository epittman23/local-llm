import {
	createSortedRowModel,
	flexRender,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
	useTable,
	type ColumnDef,
	type SortingState
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCell, humanizeHeader } from './compareFormat';

// TanStack Table v9 bundles only the features a table declares. Sorting is
// the only one this table uses; the three sort functions are the ones v9's
// 'auto' sort picks between (anything else sorts with its built-in `basic`),
// which keeps v8's automatic per-column sorting.
const features = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, datetime: sortFn_datetime, text: sortFn_text }
});

/**
 * The Compare page's generic sortable table: whatever columns the backend
 * sent, in the order it sent them. Used by the benchmark, failures and
 * serving views, whose shapes are plain rows; the config view has its own
 * per-block rendering (CompareBlocks).
 */
export function CompareDataTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const columnDefs = useMemo<ColumnDef<typeof features, Record<string, unknown>>[]>(
		() =>
			columns.map((col) => ({
				id: col,
				header: humanizeHeader(col),
				accessorFn: (row) => row[col],
				cell: (info) => formatCell(info.getValue(), col)
			})),
		[columns]
	);
	const table = useTable({
		features,
		data: rows,
		columns: columnDefs,
		state: { sorting },
		onSortingChange: setSorting
	});

	return (
		<div className="overflow-x-auto">
			<Table>
				<TableHeader>
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<TableHead
									key={header.id}
									className="cursor-pointer select-none"
									onClick={header.column.getToggleSortingHandler()}
								>
									<div className="flex items-center gap-1.5">
										{flexRender(header.column.columnDef.header, header.getContext())}
										{header.column.getIsSorted() === 'asc' && <ChevronUp className="size-3" />}
										{header.column.getIsSorted() === 'desc' && <ChevronDown className="size-3" />}
									</div>
								</TableHead>
							))}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{table.getRowModel().rows.map((row) => (
						<TableRow key={row.id}>
							{row.getAllCells().map((cell) => (
								<TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
							))}
						</TableRow>
					))}
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={Math.max(columns.length, 1)} className="text-muted-foreground text-center">
								No data
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}
