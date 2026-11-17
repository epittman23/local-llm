import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusNotice } from '@/components/ui/status-notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	cancelTestRun,
	checkServe,
	fetchDatasets,
	getDatasets,
	getLive,
	getTestOptions,
	parseBenchmarksEventStream,
	runOneItem,
	runSelfcheck,
	startTestRun,
	streamTestRun,
	type TestRunForm
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { OutcomeBadge } from './OutcomeBadge';
import {
	appendNote,
	calibrationText,
	type DatasetEvent,
	datasetEventText,
	defaultTier,
	fetchLabel,
	formatDuration,
	incrementLabel,
	missingIncrements,
	orderTiers,
	runProgress,
	TIER_SIZE,
	windowError
} from './testsFormat';

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
	| { type: 'start'; suite_run_id: string; total: number; skipped: number; window?: string | null; notes?: string[] }
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
const FAILURE = /^(fail_|no_code)/;

/** " · profile qwen38": one labelled fact of the served target, the value in mono (DAT-4). */
function Fact({ label, value }: { label: string; value?: string | number | null }) {
	if (value === undefined || value === null || value === '') return null;
	return (
		<>
			{' · '}
			{label} <span className="font-mono">{value}</span>
		</>
	);
}

/**
 * Ports d863707:apps/openwebui/src/lib/components/benchmarks/Tests.svelte: the
 * tier/benchmark/system/slice form, Run/Cancel, and the per-item SSE log
 * (parseBenchmarksEventStream unchanged, same event shapes). "All
 * benchmarks"/"No system prompt" are real Select options here (ALL_OPTION)
 * rather than an empty NativeSelect value -- shadcn's Select can't
 * represent an empty string as a selectable item.
 *
 * The tier, benchmark and system prompt are in the address (NAV-1):
 * `?tier=&benchmark=&system=`. It opens on `smoke` (B-D1).
 */
export function TestsPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [params, setParams] = useSearchParams();

	const optionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const tiers = orderTiers(optionsQuery.data?.tiers ?? []);
	const benchmarks: string[] = optionsQuery.data?.benchmarks ?? [];
	const systems: string[] = optionsQuery.data?.systems ?? [];
	const windowed = optionsQuery.data?.windows ?? {};
	const windowedNames = Object.keys(windowed);

	// What a run will measure (#938): the model Serve started, or a run Live is recording.
	const serveQuery = useQuery({ queryKey: ['serve-check'], queryFn: () => checkServe(token), enabled: !!token });
	const liveQuery = useQuery({ queryKey: ['live'], queryFn: () => getLive(token), enabled: !!token });
	const served = !!serveQuery.data?.running || !!liveQuery.data?.run;
	const targetKnown = serveQuery.isSuccess && liveQuery.isSuccess;
	const nothingServed = targetKnown && !served;

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
	const tierParam = params.get('tier') ?? '';
	const suite = tiers.includes(tierParam) ? tierParam : defaultTier(tiers);
	const benchmarkParam = params.get('benchmark') ?? '';
	const benchmark = benchmarks.includes(benchmarkParam) ? benchmarkParam : ALL_OPTION;
	const systemParam = params.get('system') ?? '';
	const system = systems.includes(systemParam) ? systemParam : ALL_OPTION;

	const [slice, setSlice] = useState('');
	const [resume, setResume] = useState(false);
	const [windowMin, setWindowMin] = useState('');
	const [windowMax, setWindowMax] = useState('');
	const [chosenIncrements, setChosenIncrements] = useState<string[]>([]);
	const [runWindow, setRunWindow] = useState<string | null>(null);
	const [confirmRefetch, setConfirmRefetch] = useState(false);

	// The window applies when the run can include a windowed benchmark.
	const windowApplies = windowedNames.length > 0 && (benchmark === ALL_OPTION || windowedNames.includes(benchmark));
	const windowProblem = windowApplies ? windowError(windowMin, windowMax) : '';
	const windowMissing = windowApplies
		? windowedNames.flatMap((name) => missingIncrements(windowed[name].increments, windowMin, windowMax))
		: [];

	const [running, setRunning] = useState(false);
	const [suiteRunId, setSuiteRunId] = useState<string | null>(null);
	const [total, setTotal] = useState(0);
	const [skipped, setSkipped] = useState(0);
	const [items, setItems] = useState<ItemEvent[]>([]);
	const [done, setDone] = useState<{ passed?: number; attempted?: number; cancelled: boolean } | null>(null);
	const [job, setJob] = useState<Job>('run');
	const [notes, setNotes] = useState<string[]>([]);
	const [result, setResult] = useState<ItemResult | null>(null);
	const [itemBenchmark, setItemBenchmark] = useState('');
	const [itemId, setItemId] = useState('');
	const [failuresOnly, setFailuresOnly] = useState(false);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const datasetsQuery = useQuery({
		queryKey: ['test-datasets'],
		queryFn: () => getDatasets(token),
		enabled: !!token
	});
	const datasets = datasetsQuery.data ?? [];
	const [streamError, setStreamError] = useState<string | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	// The elapsed time and the estimate move while a job runs.
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);

	const stopStream = () => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		setRunning(false);
	};

	const startStream = async () => {
		stopStream();
		setRunning(true);
		setStartedAt(Date.now());
		setNow(Date.now());

		const controller = new AbortController();
		abortControllerRef.current = controller;
		const [res] = await streamTestRun(token, controller).catch(() => [null] as const);

		if (controller.signal.aborted) return;
		if (!res?.body) {
			setRunning(false);
			return;
		}

		const note = (line: string) => setNotes((prev) => appendNote(prev, line));
		try {
			for await (const { event, data } of parseBenchmarksEventStream<JobEvent>(res.body)) {
				if (event === 'done') break;
				if (!data) continue;

				if (data.type === 'start') {
					setSuiteRunId(data.suite_run_id);
					setTotal(data.total);
					setSkipped(data.skipped);
					setRunWindow(data.window ?? null);
					for (const line of data.notes ?? []) note(line);
				} else if (data.type === 'item') {
					if (data.total) setTotal(data.total);
					setItems((prev) => [...prev, data]);
				} else if (data.type === 'reference') {
					const row: ItemEvent = { ...data, type: 'item', attempted: data.i };
					if (data.total) setTotal(data.total);
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
		setNow(Date.now());
		void datasetsQuery.refetch();
		void optionsQuery.refetch();
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
		setSuiteRunId(null);
		setTotal(0);
		setSkipped(0);
		setRunWindow(null);
		setStreamError(null);
		setStartedAt(null);
	};

	// Each job is started with a POST and followed on the one Tests stream.
	// Not awaited in onSuccess: see ServePage's startMutation.
	const jobMutation = useMutation({
		mutationFn: async (next: { job: Job; force?: boolean }) => {
			if (next.job === 'fetch')
				return fetchDatasets(token, {
					...(next.force ? { force: true } : {}),
					...(chosenIncrements.length ? { increments: chosenIncrements } : {})
				});
			if (next.job === 'selfcheck') return runSelfcheck(token);
			if (next.job === 'item') {
				const form = { benchmark: itemBenchmark || benchmarks[0], item_id: itemId.trim() };
				return runOneItem(token, system !== ALL_OPTION ? { ...form, system } : form);
			}
			const form: TestRunForm = { suite };
			if (benchmark !== ALL_OPTION) form.benchmark = benchmark;
			if (system !== ALL_OPTION) form.system = system;
			if (slice.trim()) form.slice = slice.trim();
			if (resume) form.resume = true;
			if (windowApplies && windowMin) {
				form.window_min = windowMin;
				if (windowMax) form.window_max = windowMax;
			}
			return startTestRun(token, form);
		},
		onMutate: (next) => reset(next.job),
		onSuccess: () => {
			void startStream();
		}
	});
	const cancelMutation = useMutation({ mutationFn: () => cancelTestRun(token) });
	const busy = jobMutation.isPending || running;
	const failedJob = jobMutation.isError ? jobMutation.variables?.job : undefined;
	const allIncrements = windowedNames.flatMap((name) => windowed[name].increments);

	const progress = runProgress(items, total, startedAt ? now - startedAt : 0);
	const shown = failuresOnly ? items.filter((item) => FAILURE.test(item.outcome)) : items;
	const showProgress = (job === 'run' || job === 'selfcheck') && (busy || items.length > 0 || done !== null);
	const passWord = job === 'selfcheck' ? 'reference solutions pass' : 'passed';

	// The log follows the newest item unless it was scrolled up to read an older one.
	const logRef = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const shownCount = shown.length;
	useEffect(() => {
		const el = logRef.current;
		if (el && shownCount && following.current) el.scrollTop = el.scrollHeight;
	}, [shownCount]);

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Tests</h2>
				<p className="text-foreground-muted text-dense">
					Run scored coding items against the model being served, and follow each answer as it is graded.
				</p>
			</div>

			{targetKnown &&
				(served ? (
					<StatusNotice
						tone="success"
						title={`Serving ${serveQuery.data?.model ?? liveQuery.data?.run?.model ?? 'a model'}`}
						action={
							<>
								<Button asChild variant="outline" size="sm">
									<Link to="/benchmarks/serve">Open Serve</Link>
								</Button>
								<Button asChild variant="outline" size="sm">
									<Link to="/benchmarks/live">Open Live</Link>
								</Button>
							</>
						}
					>
						<p>
							Tests run against this server
							<Fact label="profile" value={serveQuery.data?.profile} />
							<Fact label="configuration" value={liveQuery.data?.run?.config_id} />
							<Fact label="port" value={serveQuery.data?.port} />.
						</p>
					</StatusNotice>
				) : (
					<StatusNotice
						tone="warning"
						title="Nothing is being served"
						action={
							<Button asChild variant="outline" size="sm">
								<Link to="/benchmarks/serve">Open Serve</Link>
							</Button>
						}
					>
						<p>
							A run sends every item to the served model, so start a profile on Serve first. Selfcheck needs no model.
						</p>
					</StatusNotice>
				))}

			<section aria-labelledby="tests-datasets" className="flex flex-col gap-3 rounded-lg border px-3 py-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 id="tests-datasets" className="mr-auto text-body font-strong">
						Datasets
					</h3>
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => jobMutation.mutate({ job: 'fetch' })}>
						{fetchLabel(allIncrements, chosenIncrements)}
					</Button>
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmRefetch(true)}>
						Refetch datasets
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
				{(failedJob === 'fetch' || failedJob === 'selfcheck') && (
					<p role="alert" className="text-danger text-dense">
						Couldn't start the {failedJob}: {String(jobMutation.error)}
					</p>
				)}
				<Table aria-label="Dataset status">
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Benchmark</TableHead>
							<TableHead scope="col" className="text-right">
								Items
							</TableHead>
							<TableHead scope="col">Revision</TableHead>
							<TableHead scope="col">Calibration</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{datasets.map((d) => (
							<TableRow key={d.benchmark}>
								<TableCell>
									<span className="flex items-center gap-2">
										{d.name}
										{d.vendored && <Badge variant="secondary">In the repository</Badge>}
									</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{d.fetched ? (d.n_items ?? '–') : <Badge variant="secondary">Not fetched</Badge>}
								</TableCell>
								<TableCell className="font-mono">{d.revision ?? '–'}</TableCell>
								<TableCell>
									{d.calibration_stale ? (
										<span className="flex flex-wrap items-center gap-2">
											<span className="text-warning">{d.calibration_stale}</span>
											{d.fetched && (
												<Button
													size="xs"
													variant="outline"
													disabled={busy}
													onClick={() => jobMutation.mutate({ job: 'selfcheck' })}
												>
													Run selfcheck
												</Button>
											)}
										</span>
									) : (
										calibrationText(d)
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
				{windowedNames.map((name) => (
					<fieldset key={name} className="flex flex-col text-dense">
						<legend className="text-foreground-muted mb-1">
							{name} is fetched by release increment; the fetch downloads the ones ticked
						</legend>
						{windowed[name].increments.map((inc) => (
							// LAY-3: rows 32 px apart (44 on touch), so one box's hit area never reaches the next.
							<div key={inc.name} className="flex min-h-8 w-fit items-center gap-2 pointer-coarse:min-h-11">
								<Checkbox
									id={`tests-increment-${name}-${inc.name}`}
									checked={chosenIncrements.includes(inc.name)}
									onCheckedChange={(checked) =>
										setChosenIncrements((prev) =>
											checked === true ? [...prev, inc.name] : prev.filter((n) => n !== inc.name)
										)
									}
								/>
								<Label htmlFor={`tests-increment-${name}-${inc.name}`} className="text-dense font-normal">
									{incrementLabel(inc)}
								</Label>
							</div>
						))}
					</fieldset>
				))}
			</section>

			{optionsQuery.isLoading ? (
				<div className="flex justify-center py-4">
					<p className="text-muted-foreground text-sm">Loading…</p>
				</div>
			) : (
				<>
					<div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
						<div className="flex flex-col gap-1">
							<Label htmlFor="tests-tier">Tier</Label>
							<Select value={suite} onValueChange={(v) => setParam('tier', v)}>
								<SelectTrigger id="tests-tier" className="w-full">
									<SelectValue placeholder="Select a tier" />
								</SelectTrigger>
								<SelectContent>
									{tiers.map((tier) => (
										<SelectItem key={tier} value={tier}>
											{TIER_SIZE[tier] ? `${tier} · ${TIER_SIZE[tier]}` : tier}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="tests-benchmark">Benchmark</Label>
							<Select value={benchmark} onValueChange={(v) => setParam('benchmark', v === ALL_OPTION ? null : v)}>
								<SelectTrigger id="tests-benchmark" className="w-full">
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
							<Label htmlFor="tests-system">System prompt</Label>
							<Select value={system} onValueChange={(v) => setParam('system', v === ALL_OPTION ? null : v)}>
								<SelectTrigger id="tests-system" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL_OPTION}>No system prompt</SelectItem>
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

					{windowApplies && (
						<div className="flex flex-col gap-1">
							<div className="flex flex-wrap items-end gap-2">
								<div className="flex flex-col gap-1">
									<Label htmlFor="tests-window-min">Window from</Label>
									<Input
										id="tests-window-min"
										type="date"
										className="w-44"
										value={windowMin}
										onChange={(e) => setWindowMin(e.target.value)}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="tests-window-max">Window to</Label>
									<Input
										id="tests-window-max"
										type="date"
										className="w-44"
										value={windowMax}
										onChange={(e) => setWindowMax(e.target.value)}
									/>
								</div>
								<span className="text-muted-foreground pb-2 text-xs">
									{windowMin
										? `${windowedNames.join(', ')} problems from contests in this window`
										: `Without a window, ${windowedNames.join(', ')} is left out`}
									{windowedNames
										.map((name) => windowed[name].date_range)
										.filter((range) => range !== null)
										.map((range) => ` · fetched problems: ${range[0]} to ${range[1]}`)
										.join('')}
								</span>
							</div>
							{(windowProblem || windowMissing.length > 0) && (
								<div className="text-xs text-warning">
									{windowProblem || `This window needs ${windowMissing.join(', ')}: fetch it first.`}
								</div>
							)}
						</div>
					)}

					<div className="flex w-fit items-center gap-2 text-dense">
						<Checkbox id="tests-resume" checked={resume} onCheckedChange={(checked) => setResume(checked === true)} />
						<Label htmlFor="tests-resume" className="text-dense font-normal">
							Resume previous run
						</Label>
					</div>
				</>
			)}

			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={() => jobMutation.mutate({ job: 'run' })}
						disabled={busy || !suite || !!windowProblem || nothingServed}
						aria-describedby={nothingServed ? 'tests-run-reason' : undefined}
					>
						{jobMutation.isPending && job === 'run' ? 'Starting…' : suite ? `Run ${suite}` : 'Run'}
					</Button>
					<Button
						variant="secondary"
						onClick={() => cancelMutation.mutate()}
						disabled={cancelMutation.isPending || !running}
					>
						{cancelMutation.isPending ? 'Cancelling…' : 'Cancel run'}
					</Button>
					{nothingServed && (
						<span id="tests-run-reason" className="text-foreground-muted text-dense">
							Start a profile on Serve first.
						</span>
					)}
				</div>
				{/* FBK-1: a failure to start or cancel shows beside the button that was pressed. */}
				{failedJob === 'run' && (
					<p role="alert" className="text-danger text-dense">
						Couldn't start the run: {String(jobMutation.error)}
					</p>
				)}
				{cancelMutation.isError && (
					<p role="alert" className="text-danger text-dense">
						Couldn't cancel the run: {String(cancelMutation.error)}
					</p>
				)}
			</div>

			<section aria-label="Run one item" className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-end gap-2">
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
						disabled={busy || !itemId.trim() || !benchmarks.length || nothingServed}
						onClick={() => jobMutation.mutate({ job: 'item' })}
					>
						Run item
					</Button>
					<span className="text-muted-foreground text-xs">Graded like a run item; not recorded.</span>
				</div>
				{failedJob === 'item' && (
					<p role="alert" className="text-danger text-dense">
						Couldn't run the item: {String(jobMutation.error)}
					</p>
				)}
			</section>

			{result && (
				<div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs" data-testid="item-result">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium">
							{result.benchmark}/{result.item_id}
						</span>
						<OutcomeBadge outcome={result.outcome} />
						{result.reason && <span className="text-muted-foreground">{result.reason}</span>}
						{result.wall_ms !== undefined && (
							<span className="text-muted-foreground ml-auto">{(result.wall_ms / 1000).toFixed(1)} s</span>
						)}
					</div>
					{result.excluded && <div className="text-warning">A suite here leaves this item out: {result.excluded}</div>}
					{result.content && (
						<pre className="bg-muted max-h-72 overflow-auto rounded p-2 whitespace-pre-wrap">{result.content}</pre>
					)}
				</div>
			)}

			{streamError && (
				<p role="alert" className="text-danger text-dense">
					{streamError}
				</p>
			)}

			{notes.length > 0 && (
				<ul className="text-muted-foreground flex flex-col gap-0.5 text-xs" aria-label="Job notes">
					{notes.map((line, idx) => (
						<li key={idx}>{line}</li>
					))}
				</ul>
			)}

			{showProgress && (
				<section aria-label="Progress" className="flex flex-col gap-2 rounded-lg border px-3 py-3">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<h3 className="text-body font-strong">
							{done ? 'Done' : running ? (job === 'selfcheck' ? 'Selfcheck running' : 'Running') : 'Stopped'}
						</h3>
						{done?.cancelled && <Badge variant="secondary">Cancelled</Badge>}
						{suiteRunId && (
							<span className="text-foreground-muted min-w-0 text-dense break-all">
								Suite run <span className="text-foreground font-mono">{suiteRunId}</span>
							</span>
						)}
						{suiteRunId && job === 'run' && (
							<Button asChild variant="outline" size="sm" className="sm:ml-auto">
								<Link to={`/benchmarks/answers?run=${encodeURIComponent(suiteRunId)}`}>Open in Answers</Link>
							</Button>
						)}
					</div>
					{progress.total > 0 && (
						<div
							role="progressbar"
							aria-label={job === 'selfcheck' ? 'Selfcheck progress' : 'Run progress'}
							aria-valuemin={0}
							aria-valuemax={progress.total}
							aria-valuenow={progress.done}
							aria-valuetext={`${progress.done} of ${progress.total} items`}
							className="bg-surface-3 h-2 w-full overflow-hidden rounded-full"
						>
							<div
								className="bg-foreground-muted h-full rounded-full transition-[width]"
								style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
							/>
						</div>
					)}
					<p className="text-dense tabular-nums">
						{progress.done} of {progress.total || '–'} items · {progress.passed} {passWord}
						{progress.rate !== null && ` (${Math.round(progress.rate * 100)}%)`}
						{progress.skipped + skipped > 0 && ` · ${progress.skipped + skipped} skipped`}
						{startedAt !== null && ` · ${formatDuration(now - startedAt)} elapsed`}
						{running && progress.leftMs !== null && ` · about ${formatDuration(progress.leftMs)} left`}
						{runWindow && ` · release-date window ${runWindow}`}
					</p>
					{done?.attempted !== undefined && (
						<p className="text-dense">
							Final: {done.passed} of {done.attempted} {passWord}
						</p>
					)}

					<div className="flex items-center gap-2 text-dense">
						<Checkbox
							id="tests-failures-only"
							checked={failuresOnly}
							onCheckedChange={(checked) => setFailuresOnly(checked === true)}
						/>
						<Label htmlFor="tests-failures-only" className="text-dense font-normal">
							Show failures only
						</Label>
					</div>
					<section
						ref={logRef}
						aria-label="Item log"
						// A tab stop the arrow keys scroll, once there is something to scroll (DAT-6).
						tabIndex={shownCount ? 0 : undefined}
						onScroll={(e) => {
							const el = e.currentTarget;
							following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
						}}
						className="max-h-[60svh] min-h-32 overflow-y-auto rounded-lg border text-dense"
					>
						{shown.map((item, idx) => (
							<div
								key={idx}
								className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 border-b px-2.5 py-1.5 last:border-b-0 sm:grid-cols-[3rem_9rem_minmax(0,12rem)_auto_minmax(0,1fr)]"
							>
								<span className="text-foreground-muted text-right tabular-nums">{item.i}</span>
								<span className="truncate">{item.benchmark}</span>
								<span className="max-sm:col-start-3 max-sm:row-start-1 sm:col-start-4 sm:row-start-1">
									<OutcomeBadge outcome={item.outcome} />
								</span>
								<span className="font-mono break-all max-sm:col-span-2 max-sm:col-start-2 sm:col-start-3 sm:row-start-1">
									{item.item_id}
								</span>
								{item.reason && (
									<span className="text-foreground-muted break-words max-sm:col-span-2 max-sm:col-start-2 sm:col-start-5 sm:row-start-1">
										{item.reason}
									</span>
								)}
							</div>
						))}
						{shownCount === 0 && (
							<p className="text-muted-foreground px-2.5 py-4 text-center">
								{failuresOnly && items.length ? 'No failures so far' : 'No items yet'}
							</p>
						)}
					</section>
				</section>
			)}

			<ConfirmDialog
				open={confirmRefetch}
				onOpenChange={setConfirmRefetch}
				title="Refetch every dataset?"
				confirmLabel="Refetch datasets"
				destructive
				onConfirm={() => {
					setConfirmRefetch(false);
					jobMutation.mutate({ job: 'fetch', force: true });
				}}
			>
				Each dataset is downloaded again and replaces the copy on disk. Datasets kept in the repository are only
				checked.
			</ConfirmDialog>
		</div>
	);
}
