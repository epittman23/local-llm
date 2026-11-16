const ROWS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];

/**
 * STA-2: the placeholder for a table (Admin's lists) while its first page loads, in
 * the shape of what is coming (a heading row and a few rows), never a bare
 * spinner or an empty table.
 */
export function TableSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
	return (
		<div aria-busy="true" className="flex flex-col gap-3 py-2">
			<p className="sr-only" role="status">
				Loading {label}
			</p>
			<div className="bg-surface-3 h-4 w-1/3 animate-pulse rounded" />
			{ROWS.slice(0, rows).map((row) => (
				<div key={row} className="bg-surface-3 h-8 w-full animate-pulse rounded" />
			))}
		</div>
	);
}
