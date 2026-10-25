import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
	cancelTestRun,
	fetchDatasets,
	getDatasets,
	getTestOptions,
	parseBenchmarksEventStream,
	runOneItem,
	runSelfcheck,
	startTestRun,
	streamTestRun,
	type TestRunForm
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { calibrationText, type DatasetEvent, datasetEventText } from './testsFormat';

type ItemEvent = {
	type: 'item';
	benchmark: string;
	item_id: string;
	outcome: string;
	reason?: string;
	i: number;
	total: number;
	passed: number;
	attempted: number;
};

/** What the one-item action reports: graded like a run item, recorded nowhere. */
type ItemResult = {
	benchmark: string;
	item_id: string;
	model?: string;
	outcome: string;
	reason?: string;
	/** Why a suite here would leave this item out; '' when it would not. */
	excluded?: string;
	wall_ms?: number;
	content?: string;
};

/** The events every Tests job streams: a suite run, a fetch, a selfcheck, or one item. */
type JobEvent =
	| { type: 'start'; suite_run_id: string; total: number; skipped: number }
	| ItemEvent
	| {
			type: 'reference';
			benchmark: string;
			item_id: string;
			outcome: string;
			reason?: string;
			i: number;
			total: number;
			passed: number;
	  }
	| { type: 'progress'; benchmark: string; message: string; total?: number }
	| ({ type: 'dataset' } & DatasetEvent)
	| { type: 'calibrated'; benchmark: string; n_checked: number; n_ungradeable: number }
	| ({ type: 'result' } & ItemResult)
	| { type: 'done'; passed?: number; attempted?: number; cancelled: boolean }
	| { type: 'error'; message: string };

type Job = 'run' | 'fetch' | 'selfcheck' | 'item';

const ALL_OPTION = '__all__';

const outcomeBadgeVariant = (outcome: string): 'default' | 'destructive' | 'secondary' | 'outline' => {
	const o = (outcome ?? '').toLowerCase();
	if (o === 'pass' || o === 'passed') return 'default';
	if (o === 'fail' || o === 'failed') return 'destructive';
	if (o === 'skip' || o === 'skipped') return 'secondary';
	return 'outline';
};

/**
 * Ports d863707:apps/openwebui/src/lib/components/benchmarks/Tests.svelte: the
 * tier/benchmark/system/slice form, Run/Cancel, and the per-item SSE log
 * (parseBenchmarksEventStream unchanged, same event shapes). "All
 * benchmarks"/"All systems" are real Select options here (ALL_OPTION)
 * rather than an empty NativeSelect value -- shadcn's Select can't
 * represent an empty string as a selectable item.
 */
export function TestsPage() {
	const token = useAuthStore((state) => state.token) ?? '';

	const optionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const tiers: string[] = optionsQuery.data?.tiers ?? [];
	const benchmarks: string[] = optionsQuery.data?.benchmarks ?? [];
	const systems: string[] = optionsQuery.data?.systems ?? [];

	const [suite, setSuite] = useState('');
	const [benchmark, setBenchmark] = useState(ALL_OPTION);
	const [system, setSystem] = useState(ALL_OPTION);
	const [slice, setSlice] = useState('');
	const [resume, setResume] = useState(false);

	const effectiveSuite = suite || tiers[0] || '';

	const [running, setRunning] = useState(false);
	const [suiteRunId, setSuiteRunId] = useState<string | null>(null);
	const [total, setTotal] = useState(0);
	const [skipped, setSkipped] = useState(0);
	const [latest, setLatest] = useState<ItemEvent | null>(null);
	const [items, setItems] = useState<ItemEvent[]>([]);
	const [done, setDone] = useState<{ passed?: number; attempted?: number; cancelled: boolean } | null>(null);
	const [job, setJob] = useState<Job>('run');
	const [notes, setNotes] = useState<string[]>([]);
	const [result, setResult] = useState<ItemResult | null>(null);
	const [itemBenchmark, setItemBenchmark] = useState('');
	const [itemId, setItemId] = useState('');

	const datasetsQuery = useQuery({
		queryKey: ['test-datasets'],
		queryFn: () => getDatasets(token),
		enabled: !!token
	});
	const datasets = datasetsQuery.data ?? [];
	const [streamError, setStreamError] = useState<string | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	const stopStream = () => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		setRunning(false);
	};

	const startStream = async () => {
		stopStream();
		setRunning(true);

		const controller = new AbortController();
		abortControllerRef.current = controller;
		const [res] = await streamTestRun(token, controller).catch(() => [null] as const);

		if (controller.signal.aborted) return;
		if (!res?.body) {
			setRunning(false);
			return;
		}

		const note = (line: string) => setNotes((prev) => [...prev, line]);
		try {
			for await (const { event, data } of parseBenchmarksEventStream<JobEvent>(res.body)) {
				if (event === 'done') break;
				if (!data) continue;

				if (data.type === 'start') {
					setSuiteRunId(data.suite_run_id);
					setTotal(data.total);
					setSkipped(data.skipped);
				} else if (data.type === 'item') {
					setLatest(data);
					setItems((prev) => [...prev, data]);
				} else if (data.type === 'reference') {
					const row: ItemEvent = { ...data, type: 'item', attempted: data.i };
					setLatest(row);
					setItems((prev) => [...prev, row]);
				} else if (data.type === 'progress') {
					note(`${data.benchmark}: ${data.message}${data.total ? ` ${data.total} reference solutions` : ''}`);
				} else if (data.type === 'dataset') {
					note(datasetEventText(data));
				} else if (data.type === 'calibrated') {
					note(
						`${data.benchmark}: calibrated, ${data.n_checked - data.n_ungradeable}/${data.n_checked} gradeable here`
					);
				} else if (data.type === 'result') {
					const { type: _type, ...rest } = data;
					setResult(rest);
				} else if (data.type === 'done') {
					setDone({ passed: data.passed, attempted: data.attempted, cancelled: data.cancelled });
				} else if (data.type === 'error') {
					setStreamError(data.message);
					break;
				}
			}
		} catch (err) {
			console.error(err);
		}
		void datasetsQuery.refetch();
		if (abortControllerRef.current === controller) setRunning(false);
	};

	// Abort the SSE connection when leaving the page.
	useEffect(() => () => abortControllerRef.current?.abort(), []);

	const reset = (next: Job) => {
		setJob(next);
		setDone(null);
		setItems([]);
		setNotes([]);
		setResult(null);
		setLatest(null);
		setSuiteRunId(null);
		setTotal(0);
		setSkipped(0);
		setStreamError(null);
	};

	// Each job is started with a POST and followed on the one Tests stream.
	// Not awaited in onSuccess: see ServePage's startMutation.
	const jobMutation = useMutation({
		mutationFn: async (next: { job: Job; force?: boolean }) => {
			if (next.job === 'fetch') return fetchDatasets(token, next.force ? { force: true } : {});
			if (next.job === 'selfcheck') return runSelfcheck(token);
			if (next.job === 'item') {
				const form = { benchmark: itemBenchmark || benchmarks[0], item_id: itemId.trim() };
				return runOneItem(token, system !== ALL_OPTION ? { ...form, system } : form);
			}
			const form: TestRunForm = { suite: effectiveSuite };
			if (benchmark !== ALL_OPTION) form.benchmark = benchmark;
			if (system !== ALL_OPTION) form.system = system;
			if (slice.trim()) form.slice = slice.trim();
			if (resume) form.resume = true;
			return startTestRun(token, form);
		},
		onMutate: (next) => reset(next.job),
		onSuccess: () => {
			void startStream();
		}
	});
	const cancelMutation = useMutation({ mutationFn: () => cancelTestRun(token) });
	const busy = jobMutation.isPending || running;

	return (
		<div className="flex flex-col gap-4">
			<h2 className="text-lg font-medium">Tests</h2>

			{(jobMutation.isError || cancelMutation.isError) && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					{jobMutation.error ? `Could not start: ${jobMutation.error}` : 'Failed to cancel test run'}
				</div>
			)}

			<section aria-label="Datasets" className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<div className="mr-auto text-sm font-medium">Datasets</div>
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => jobMutation.mutate({ job: 'fetch' })}>
						Fetch
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() => {
							if (window.confirm('Download every dataset again, replacing the copies on disk?'))
								jobMutation.mutate({ job: 'fetch', force: true });
						}}
					>
						Force refetch
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={busy || !datasets.some((d) => d.fetched)}
						onClick={() => jobMutation.mutate({ job: 'selfcheck' })}
					>
						Selfcheck
					</Button>
				</div>
				<table className="text-xs">
					<thead className="text-muted-foreground text-left">
						<tr>
							<th className="font-normal">Benchmark</th>
							<th className="font-normal">Items</th>
							<th className="font-normal">Revision</th>
							<th className="font-normal">Calibration</th>
						</tr>
					</thead>
					<tbody>
						{datasets.map((d) => (
							<tr key={d.benchmark}>
								<td>{d.name}</td>
								<td>{d.fetched ? d.n_items : 'not fetched'}</td>
								<td className="font-mono">{d.revision ?? '-'}</td>
								<td className={d.calibration_stale ? 'text-amber-600 dark:text-amber-400' : ''}>
									{calibrationText(d)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			{optionsQuery.isLoading ? (
				<div className="flex justify-center py-4">
					<p className="text-muted-foreground text-sm">Loading…</p>
				</div>
			) : (
				<>
					<div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
						<div className="flex flex-col gap-1">
							<Label>Tier</Label>
							<Select value={effectiveSuite} onValueChange={setSuite}>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select a tier" />
								</SelectTrigger>
								<SelectContent>
									{tiers.map((tier) => (
										<SelectItem key={tier} value={tier}>
											{tier}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label>Benchmark</Label>
							<Select value={benchmark} onValueChange={setBenchmark}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL_OPTION}>All benchmarks</SelectItem>
									{benchmarks.map((b) => (
										<SelectItem key={b} value={b}>
											{b}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label>System</Label>
							<Select value={system} onValueChange={setSystem}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL_OPTION}>All systems</SelectItem>
									{systems.map((s) => (
										<SelectItem key={s} value={s}>
											{s}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="tests-slice">Slice</Label>
							<Input
								id="tests-slice"
								placeholder="e.g. 0:50"
								value={slice}
								onChange={(e) => setSlice(e.target.value)}
							/>
						</div>
					</div>

					<label className="flex w-fit items-center gap-2 text-xs">
						<Checkbox checked={resume} onCheckedChange={(checked) => setResume(checked === true)} />
						Resume previous run
					</label>
				</>
			)}

			<div className="flex items-center gap-2">
				<Button onClick={() => jobMutation.mutate({ job: 'run' })} disabled={busy || !effectiveSuite}>
					{jobMutation.isPending && job === 'run' ? 'Starting…' : 'Run'}
				</Button>
				<Button
					variant="secondary"
					onClick={() => cancelMutation.mutate()}
					disabled={cancelMutation.isPending || !running}
				>
					{cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
				</Button>

				{running && (
					<div className="text-muted-foreground ml-2 text-xs">
						{latest
							? `${latest.i}/${latest.total || total} - ${latest.passed} ${job === 'selfcheck' ? 'reference solutions pass' : 'passed'}`
							: 'Starting…'}
					</div>
				)}
			</div>

			<section aria-label="Run one item" className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor="tests-item-benchmark">Item benchmark</Label>
					<Select value={itemBenchmark || benchmarks[0] || ''} onValueChange={setItemBenchmark}>
						<SelectTrigger id="tests-item-benchmark" className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{benchmarks.map((b) => (
								<SelectItem key={b} value={b}>
									{b}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="tests-item-id">Item id</Label>
					<Input
						id="tests-item-id"
						className="w-48"
						placeholder="e.g. HumanEval/0"
						value={itemId}
						onChange={(e) => setItemId(e.target.value)}
					/>
				</div>
				<Button
					variant="secondary"
					disabled={busy || !itemId.trim() || !benchmarks.length}
					onClick={() => jobMutation.mutate({ job: 'item' })}
				>
					Run item
				</Button>
				<span className="text-muted-foreground text-xs">Graded like a run item; not recorded.</span>
			</section>

			{result && (
				<div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs" data-testid="item-result">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium">
							{result.benchmark}/{result.item_id}
						</span>
						<Badge variant={outcomeBadgeVariant(result.outcome)}>{result.outcome}</Badge>
						{result.reason && <span className="text-muted-foreground">{result.reason}</span>}
						{result.wall_ms !== undefined && (
							<span className="text-muted-foreground ml-auto">{(result.wall_ms / 1000).toFixed(1)}s</span>
						)}
					</div>
					{result.excluded && (
						<div className="text-amber-600 dark:text-amber-400">
							A suite here leaves this item out: {result.excluded}
						</div>
					)}
					{result.content && (
						<pre className="bg-muted max-h-72 overflow-auto rounded p-2 whitespace-pre-wrap">{result.content}</pre>
					)}
				</div>
			)}

			{streamError && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					{streamError}
				</div>
			)}

			{suiteRunId && (
				<div className="text-muted-foreground text-xs">
					Suite run: <span className="text-foreground">{suiteRunId}</span> · Total: {total} · Skipped: {skipped}
				</div>
			)}

			{notes.length > 0 && (
				<ul className="text-muted-foreground flex flex-col gap-0.5 text-xs" aria-label="Job notes">
					{notes.map((line, idx) => (
						<li key={idx}>{line}</li>
					))}
				</ul>
			)}

			<div className="flex flex-col gap-1">
				<div className="text-sm">Item Log</div>
				<div className="h-72 overflow-y-auto rounded-lg border text-xs">
					{items.map((item, idx) => (
						<div key={idx} className="flex items-center gap-2 border-b px-2.5 py-1 last:border-b-0">
							<span className="text-muted-foreground w-10 shrink-0">{item.i}</span>
							<span className="truncate">{item.benchmark}</span>
							<span className="text-muted-foreground flex-1 truncate">{item.item_id}</span>
							<Badge variant={outcomeBadgeVariant(item.outcome)}>{item.outcome}</Badge>
							{item.reason && <span className="text-muted-foreground max-w-48 truncate">{item.reason}</span>}
						</div>
					))}
					{items.length === 0 && <div className="text-muted-foreground px-2.5 py-4 text-center">No items yet</div>}
				</div>
			</div>

			{done && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2.5 text-xs">
					<span className="text-sm font-medium">Done</span>
					{done.attempted !== undefined && (
						<span className="text-muted-foreground">
							{done.passed} / {done.attempted} passed
						</span>
					)}
					{done.cancelled && <Badge variant="secondary">Cancelled</Badge>}
				</div>
			)}
		</div>
	);
}
