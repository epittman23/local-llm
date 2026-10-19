import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
	exportAnswers,
	getCompare,
	getTestOptions,
	type CompareBy,
	type CompareConfigResponse
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { CompareBlocks } from './CompareBlocks';
import { CompareDataTable } from './CompareDataTable';

const ALL_TIER = '__all__';

const byOptions: { value: CompareBy; label: string }[] = [
	{ value: 'config', label: 'Config' },
	{ value: 'benchmark', label: 'Benchmark' },
	{ value: 'failures', label: 'Failures' },
	{ value: 'serving', label: 'Serving' }
];

const isWarningNote = (note: string): boolean => /^\s*(>\s*)?warning\b/i.test(note);

const columnsOf = (rows: Record<string, unknown>[] | undefined): string[] => (rows?.[0] ? Object.keys(rows[0]) : []);

/**
 * Four views of the same results. The config view is per block, with the
 * intervals, group letters and paired comparisons the backend computes
 * (analysis/estimators.py); the other three are plain tables, whose columns
 * come from the backend rather than a hardcoded list:
 *   - benchmark -> { columns, rows, notes }, flat per-benchmark columns
 *   - failures  -> { rows, notes }
 *   - serving   -> { rows, derived, notes }, two tables
 */
export function ComparePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [by, setBy] = useState<CompareBy>('config');
	const [tier, setTier] = useState(ALL_TIER);
	const [baseline, setBaseline] = useState('');
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

	const data = compareQuery.data;
	const notes: string[] = [...new Set<string>(data?.notes ?? [])];

	const exportMutation = useMutation({
		mutationFn: () => exportAnswers(token, exportRun.trim())
	});

	const renderView = () => {
		if (by === 'config') {
			const config = (data ?? { rows: [], blocks: [], notes: [] }) as CompareConfigResponse;
			return <CompareBlocks blocks={config.blocks ?? []} rows={config.rows ?? []} baseline={!!baseline.trim()} />;
		}
		if (by === 'benchmark') {
			return <CompareDataTable columns={data?.columns ?? []} rows={data?.rows ?? []} />;
		}
		if (by === 'serving') {
			return (
				<div className="flex flex-col gap-4">
					<CompareDataTable columns={columnsOf(data?.rows)} rows={data?.rows ?? []} />
					<div className="text-sm">Derived</div>
					<CompareDataTable columns={columnsOf(data?.derived)} rows={data?.derived ?? []} />
				</div>
			);
		}
		return <CompareDataTable columns={columnsOf(data?.rows)} rows={data?.rows ?? []} />;
	};

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
					{renderView()}

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
					{exportMutation.isError && <span className="text-destructive text-xs">Failed to export answers</span>}
				</div>
			</div>
		</div>
	);
}
