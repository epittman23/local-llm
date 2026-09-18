import {
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnDef,
	type SortingState
} from '@tanstack/react-table';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { exportAnswers, getCompare, getTestOptions, type CompareBy } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';

const ALL_TIER = '__all__';

const byOptions: { value: CompareBy; label: string }[] = [
	{ value: 'config', label: 'Config' },
	{ value: 'benchmark', label: 'Benchmark' },
	{ value: 'failures', label: 'Failures' },
	{ value: 'serving', label: 'Serving' }
];

const humanizeHeader = (col: string): string =>
	col
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());

const isRateColumn = (col: string): boolean => /(^|_)(pass_rate|rate)$/i.test(col);
const formatRate = (value: number): string => `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;

const formatObject = (value: Record<string, unknown>): string => {
	const entries = Object.entries(value);
	if (!entries.length) return '—';
	return entries
		.map(([key, val]) => {
			if (val && typeof val === 'object' && !Array.isArray(val)) {
				const cell = val as Record<string, unknown>;
				if ('passed' in cell && 'attempted' in cell) return `${key} ${cell.passed}/${cell.attempted}`;
				return `${key}: ${formatObject(cell)}`;
			}
			return `${key}=${formatCell(val)}`;
		})
		.join(', ');
};

function formatCell(value: unknown, col: string = ''): string {
	if (value === null || value === undefined || value === '') return '—';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (typeof value === 'number') {
		if (isRateColumn(col) && value >= 0 && value <= 1) return formatRate(value);
		return Number.isInteger(value)
			? value.toString()
			: value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	}
	if (Array.isArray(value)) return value.length ? value.map((v) => formatCell(v)).join(', ') : '—';
	if (typeof value === 'object') return formatObject(value as Record<string, unknown>);
	return String(value);
}

const isWarningNote = (note: string): boolean => /^\s*warning\b/i.test(note);

/**
 * Ports Compare.svelte's generic column/row rendering onto TanStack Table
 * (per Phase 5's own checklist wording, docs/migration-plan.md), rather than
 * a hand-rolled sort. The response shape genuinely varies with `by` -- see
 * that file's own comment, ported verbatim below -- normalized into one
 * (columns, rows) shape before it ever reaches the table.
 */
export function ComparePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [by, setBy] = useState<CompareBy>('config');
	const [tier, setTier] = useState(ALL_TIER);
	const [baseline, setBaseline] = useState('');
	const [sorting, setSorting] = useState<SortingState>([]);
	const [exportRun, setExportRun] = useState('');

	const tierOptionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const tiers: string[] = tierOptionsQuery.data?.tiers ?? [];

	const compareQuery = useQuery({
		queryKey: ['compare', by, tier, baseline],
		queryFn: () =>
			getCompare(token, {
				by,
				tier: tier === ALL_TIER ? null : tier,
				baseline: by === 'config' && baseline.trim() ? baseline.trim() : null
			}),
		enabled: !!token
	});

	// The response shape genuinely varies with `by`:
	//   - config / failures -> { rows, notes }
	//   - benchmark         -> { columns, rows, notes }
	//   - serving           -> { derived_columns, derived, notes }
	// Normalized into one generic (columns: string[], rows: object[]) shape
	// the table renders without caring which mode produced it. For
	// config/failures there's no explicit column list from the backend, so
	// columns come from the first row's own keys, in the order the backend
	// returned them, rather than a hardcoded list.
	const data = compareQuery.data;
	const columns: string[] =
		by === 'benchmark'
			? (data?.columns ?? [])
			: by === 'serving'
				? (data?.derived_columns ?? [])
				: data?.rows?.[0]
					? Object.keys(data.rows[0])
					: [];
	const rows: Record<string, unknown>[] = by === 'serving' ? (data?.derived ?? []) : (data?.rows ?? []);
	const notes: string[] = [...new Set<string>(data?.notes ?? [])];

	const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
		() =>
			columns.map((col) => ({
				id: col,
				header: humanizeHeader(col),
				accessorFn: (row) => row[col],
				cell: (info) => formatCell(info.getValue(), col)
			})),
		[columns]
	);

	const table = useReactTable({
		data: rows,
		columns: columnDefs,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	const exportMutation = useMutation({
		mutationFn: () => exportAnswers(token, exportRun.trim())
	});

	return (
		<div className="flex flex-col gap-2">
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h2 className="shrink-0 text-lg font-medium">Compare</h2>

				<div className="flex flex-wrap items-center justify-end gap-2">
					<Select value={by} onValueChange={(v) => setBy(v as CompareBy)}>
						<SelectTrigger className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{byOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<Select value={tier} onValueChange={setTier}>
						<SelectTrigger className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL_TIER}>All</SelectItem>
							{tiers.map((t) => (
								<SelectItem key={t} value={t}>
									{t}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{by === 'config' && (
						<Input
							className="w-44"
							placeholder="Baseline config id"
							value={baseline}
							onChange={(e) => setBaseline(e.target.value)}
						/>
					)}
				</div>
			</div>

			{compareQuery.isLoading ? (
				<div className="my-10 flex justify-center">
					<p className="text-muted-foreground text-sm">Loading…</p>
				</div>
			) : compareQuery.isError ? (
				<div className="text-destructive px-0.5 py-4 text-xs">Failed to load comparison</div>
			) : (
				<>
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
													{header.column.getIsSorted() === 'desc' && (
														<ChevronDown className="size-3" />
													)}
												</div>
											</TableHead>
										))}
									</TableRow>
								))}
							</TableHeader>
							<TableBody>
								{table.getRowModel().rows.map((row) => (
									<TableRow key={row.id}>
										{row.getVisibleCells().map((cell) => (
											<TableCell key={cell.id}>
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</TableCell>
										))}
									</TableRow>
								))}
								{rows.length === 0 && (
									<TableRow>
										<TableCell
											colSpan={Math.max(columns.length, 1)}
											className="text-muted-foreground text-center"
										>
											No data
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>

					{notes.length > 0 && (
						<ul className="mt-2 space-y-1 px-0.5">
							{notes.map((note, i) => (
								<li
									key={i}
									className={
										isWarningNote(note)
											? 'w-fit rounded-sm bg-yellow-500/20 px-2 py-1 text-xs text-yellow-700 dark:text-yellow-200'
											: 'text-muted-foreground text-xs'
									}
								>
									{note}
								</li>
							))}
						</ul>
					)}
				</>
			)}

			<div className="mt-6 flex flex-col gap-1.5 border-t pt-4">
				<div className="text-sm">Export Answers</div>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						className="w-56"
						placeholder="Suite run id"
						value={exportRun}
						onChange={(e) => setExportRun(e.target.value)}
					/>
					<Button
						size="sm"
						variant="secondary"
						disabled={exportMutation.isPending || !exportRun.trim()}
						onClick={() => exportMutation.mutate()}
					>
						{exportMutation.isPending ? 'Exporting…' : 'Export'}
					</Button>
					{exportMutation.isSuccess && (
						<span className="text-xs text-green-700 dark:text-green-300">
							Exported {exportMutation.data.exported} answers to {exportMutation.data.directory}
						</span>
					)}
					{exportMutation.isError && (
						<span className="text-destructive text-xs">Failed to export answers</span>
					)}
				</div>
			</div>
		</div>
	);
}
