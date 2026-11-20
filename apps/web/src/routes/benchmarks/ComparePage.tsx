import { useMutation, useQuery } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusNotice } from '@/components/ui/status-notice';
import {
	type CompareBy,
	type CompareConfigResponse,
	exportAnswers,
	getCompare,
	getTestOptions
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { CompareBlocks } from './CompareBlocks';
import { CompareDataTable } from './CompareDataTable';
import { configLabel, configurations, type NoteParts, parseNote, splitFlags } from './compareFormat';

const ALL_TIER = '__all__';
const NO_BASELINE = '__none__';

const byOptions: { value: CompareBy; label: string }[] = [
	{ value: 'config', label: 'Config' },
	{ value: 'benchmark', label: 'Benchmark' },
	{ value: 'failures', label: 'Failures' },
	{ value: 'serving', label: 'Serving' }
];

const columnsOf = (rows: Record<string, unknown>[] | undefined): string[] => (rows?.[0] ? Object.keys(rows[0]) : []);

/** B-D9: a failure opens its answer in Answers (the URL contract's `?run=&benchmark=&item=`). */
export function answerHref(row: Record<string, unknown>): string | null {
	const run = row.suite_run_id;
	if (typeof run !== 'string' || !run) return null;
	const params = new URLSearchParams({ run, benchmark: String(row.benchmark ?? ''), item: String(row.item_id ?? '') });
	return `${routePaths.benchmarksAnswers}?${params}`;
}

/** A note's sentence, its ids as code. */
function NoteText({ note }: { note: NoteParts }) {
	return (
		<>
			{note.parts.map((part) =>
				part.code ? (
					<code key={part.key} className="font-mono">
						{part.text}
					</code>
				) : (
					<span key={part.key}>{part.text}</span>
				)
			)}
		</>
	);
}

/**
 * Four views of the same results. The config view is per block, with the
 * intervals, group letters and paired comparisons the backend computes
 * (analysis/estimators.py); the other three are plain tables, whose columns
 * come from the backend rather than a hardcoded list:
 *   - benchmark -> { columns, rows, notes }, flat per-benchmark columns
 *   - failures  -> { rows, notes }
 *   - serving   -> { rows, derived, notes }, two tables
 *
 * The view, tier and baseline are in the address (NAV-1:
 * `?by=&tier=&baseline=`); changing one replaces the entry. Warnings that
 * decide whether a comparison may be read come first, above the tables
 * (FBK-1, #1043); the notes on how to read it are behind "How to read this".
 */
export function ComparePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [params, setParams] = useSearchParams();
	const byParam = params.get('by');
	const by: CompareBy = byOptions.some((o) => o.value === byParam) ? (byParam as CompareBy) : 'config';
	const tier = params.get('tier') || ALL_TIER;
	const baseline = (params.get('baseline') ?? '').trim();
	const [exportRun, setExportRun] = useState('');

	const setParam = (key: string, value: string | null) =>
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true }
		);

	const tierOptionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const tiers: string[] = tierOptionsQuery.data?.tiers ?? [];
	// A tier the server doesn't offer (an old link, `?tier=nightly`) would
	// leave the select blank: fall back to all tiers and say so in the address (NAV-3).
	const unknownTier = tierOptionsQuery.isSuccess && tier !== ALL_TIER && !tiers.includes(tier);
	useEffect(() => {
		if (unknownTier) setParam('tier', null);
	});

	const compareQuery = useQuery({
		queryKey: ['compare', by, tier, by === 'config' ? baseline : ''],
		queryFn: () =>
			getCompare(token, {
				by,
				tier: tier === ALL_TIER ? null : tier,
				baseline: by === 'config' && baseline ? baseline : null
			}),
		enabled: !!token,
		// A new baseline only adds a column: keep the rows (and the select the
		// focus moves to) on screen while it loads, rather than a skeleton.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === by && previousQuery.queryKey[2] === tier ? previous : undefined
	});
	const baselineSelect = useRef<HTMLButtonElement>(null);

	const data = compareQuery.data;
	const notes = [...new Set<string>(data?.notes ?? [])].map(parseNote);
	const warnings = notes.filter((note) => note.tone === 'warning');
	const readingNotes = notes.filter((note) => note.tone === 'note');

	const config = (
		by === 'config' ? (data ?? { rows: [], blocks: [], notes: [] }) : null
	) as CompareConfigResponse | null;
	const configRows = config?.rows ?? [];
	const configs = configurations(configRows);
	const configVarying = splitFlags(configs).varying;
	const baselineKnown = !!baseline && configs.some((row) => row.config_id === baseline);
	const baselineUnknown = by === 'config' && !!baseline && !!data && !baselineKnown;

	const exportMutation = useMutation({
		mutationFn: () => exportAnswers(token, exportRun.trim()),
		onSuccess: (result) => toast.success(`Exported ${result.exported} answers to ${result.directory}`),
		onError: (error) => toastFailure("Couldn't export the answers. Check the run id and try again.", error)
	});

	const isEmpty =
		by === 'config'
			? (config?.blocks ?? []).length === 0
			: by === 'serving'
				? (data?.rows ?? []).length === 0 && (data?.derived ?? []).length === 0
				: (data?.rows ?? []).length === 0;

	const renderView = () => {
		if (isEmpty) {
			return (
				<ListEmptyState
					title="No results to compare yet"
					description="Compare reads the results of runs from the Tests page, grouped by configuration."
					action={
						<Button variant="outline" size="sm" asChild>
							<Link to={routePaths.benchmarksTests}>Open Tests</Link>
						</Button>
					}
					filtered={tier !== ALL_TIER}
					onClear={() => setParam('tier', null)}
				/>
			);
		}
		if (by === 'config') {
			return (
				<CompareBlocks
					blocks={config?.blocks ?? []}
					rows={configRows}
					baseline={baselineKnown ? baseline : null}
					baselinePending={compareQuery.isPlaceholderData}
					onBaseline={(id) => {
						setParam('baseline', id);
						// The pressed button goes with its row's new state: focus moves to
						// the select now naming the baseline (A11Y-1).
						baselineSelect.current?.focus();
					}}
				/>
			);
		}
		if (by === 'benchmark') {
			return (
				<CompareDataTable
					label="Pass rate by benchmark"
					columns={data?.columns ?? []}
					rows={data?.rows ?? []}
					stickyHeader
				/>
			);
		}
		if (by === 'serving') {
			return (
				<div className="flex flex-col gap-6">
					<CompareDataTable label="Serving measurements" columns={columnsOf(data?.rows)} rows={data?.rows ?? []} />
					<div className="flex flex-col gap-1">
						<h3 className="font-strong px-0.5">Derived</h3>
						<p className="text-foreground-muted text-dense px-0.5">
							Worked out from the measurements above: the layers left on the CPU, the time each token takes, and the
							memory bandwidth that time implies.
						</p>
						<CompareDataTable
							label="Derived from the serving measurements"
							columns={columnsOf(data?.derived)}
							rows={data?.derived ?? []}
						/>
					</div>
				</div>
			);
		}
		return (
			<CompareDataTable
				label="Failures"
				columns={columnsOf(data?.rows)}
				rows={data?.rows ?? []}
				stickyHeader
				rowHref={answerHref}
			/>
		);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
				<h2 className="shrink-0 text-lg font-medium">Compare</h2>

				<div className="grid w-full grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-x-4">
					<div className="contents sm:flex sm:items-center sm:gap-2">
						<Label htmlFor="compare-by" className="text-muted-foreground font-normal">
							Compare by
						</Label>
						<Select value={by} onValueChange={(v) => setParam('by', v === 'config' ? null : v)}>
							<SelectTrigger id="compare-by" className="w-full sm:w-36">
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
					</div>

					<div className="contents sm:flex sm:items-center sm:gap-2">
						<Label htmlFor="compare-tier" className="text-muted-foreground font-normal">
							Tier
						</Label>
						<Select value={tier} onValueChange={(v) => setParam('tier', v === ALL_TIER ? null : v)}>
							<SelectTrigger id="compare-tier" className="w-full sm:w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_TIER}>All tiers</SelectItem>
								{tiers.map((t) => (
									<SelectItem key={t} value={t}>
										{t}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{by === 'config' && (
						<div className="contents sm:flex sm:min-w-0 sm:items-center sm:gap-2">
							<Label htmlFor="compare-baseline" className="text-muted-foreground font-normal">
								Baseline
							</Label>
							<Select
								value={baselineKnown ? baseline : NO_BASELINE}
								onValueChange={(v) => setParam('baseline', v === NO_BASELINE ? null : v)}
								disabled={configs.length === 0}
							>
								{/* The value is a configuration in words: it wraps to two lines rather than clip. */}
								<SelectTrigger
									ref={baselineSelect}
									id="compare-baseline"
									className="min-h-9 w-full whitespace-normal text-start data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-2 sm:w-fit sm:max-w-md"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_BASELINE}>None</SelectItem>
									{configs.map((row) => (
										<SelectItem key={row.config_id} value={row.config_id}>
											{configLabel(row, configVarying)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
				</div>
			</div>

			{compareQuery.isLoading ? (
				<TableSkeleton label="Loading the comparison" />
			) : compareQuery.isError ? (
				<LoadFailed
					what="the comparison"
					error={compareQuery.error}
					onRetry={() => compareQuery.refetch()}
					retrying={compareQuery.isFetching}
				/>
			) : (
				<>
					{baselineUnknown && (
						<StatusNotice
							tone="warning"
							title={`No configuration ${baseline} in these results`}
							action={
								<Button variant="outline" size="sm" onClick={() => setParam('baseline', null)}>
									Clear baseline
								</Button>
							}
						>
							<p>Pick a baseline from the list, or use Set as baseline on a row.</p>
						</StatusNotice>
					)}
					{warnings.length > 0 && (
						<StatusNotice
							tone="warning"
							title={
								warnings.length === 1
									? 'Read this comparison with care'
									: `Read these comparisons with care (${warnings.length})`
							}
						>
							<ul className="flex list-disc flex-col gap-1 pl-4">
								{warnings.map((note) => (
									<li key={note.raw}>
										<NoteText note={note} />
									</li>
								))}
							</ul>
						</StatusNotice>
					)}

					{renderView()}

					{readingNotes.length > 0 && (
						<details className="text-dense px-0.5">
							<summary className="text-foreground-muted inline-flex w-fit cursor-pointer items-center gap-1.5">
								<InfoIcon aria-hidden className="size-3.5" />
								How to read this ({readingNotes.length})
							</summary>
							<ul className="mt-1.5 flex max-w-prose list-disc flex-col gap-1 pl-5">
								{readingNotes.map((note) => (
									<li key={note.raw}>
										<NoteText note={note} />
									</li>
								))}
							</ul>
						</details>
					)}
				</>
			)}

			<section aria-labelledby="compare-export" className="mt-6 flex flex-col gap-1.5 border-t pt-4">
				<h3 id="compare-export" className="font-strong">
					Export answers
				</h3>
				<p className="text-foreground-muted text-dense">
					Writes every graded answer of one run as markdown files on the server.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Label htmlFor="compare-export-run" className="text-muted-foreground font-normal">
						Run id
					</Label>
					<Input
						id="compare-export-run"
						className="w-64 font-mono"
						placeholder="20261115T0605Z-…"
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
				</div>
			</section>
		</div>
	);
}
