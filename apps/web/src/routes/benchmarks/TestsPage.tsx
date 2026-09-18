import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
import {
	cancelTestRun,
	getTestOptions,
	parseBenchmarksEventStream,
	startTestRun,
	streamTestRun,
	type TestRunForm
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';

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

const ALL_OPTION = '__all__';

const outcomeBadgeVariant = (outcome: string): 'default' | 'destructive' | 'secondary' | 'outline' => {
	const o = (outcome ?? '').toLowerCase();
	if (o === 'pass' || o === 'passed') return 'default';
	if (o === 'fail' || o === 'failed') return 'destructive';
	if (o === 'skip' || o === 'skipped') return 'secondary';
	return 'outline';
};

/**
 * Ports apps/openwebui/src/lib/components/benchmarks/Tests.svelte: the
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
	const [done, setDone] = useState<{ passed: number; attempted: number; cancelled: boolean } | null>(
		null
	);
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

		const [res, controller] = await streamTestRun(token);
		abortControllerRef.current = controller;

		if (!res?.body) {
			setRunning(false);
			return;
		}

		try {
			for await (const { event, data } of parseBenchmarksEventStream<
				| { type: 'start'; suite_run_id: string; total: number; skipped: number }
				| ItemEvent
				| { type: 'done'; passed: number; attempted: number; cancelled: boolean }
				| { type: 'error'; message: string }
			>(res.body)) {
				if (event === 'done') break;
				if (!data) continue;

				if (data.type === 'start') {
					setSuiteRunId(data.suite_run_id);
					setTotal(data.total);
					setSkipped(data.skipped);
				} else if (data.type === 'item') {
					setLatest(data);
					setItems((prev) => [...prev, data]);
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
		setRunning(false);
	};

	const runMutation = useMutation({
		mutationFn: () => {
			const form: TestRunForm = { suite: effectiveSuite };
			if (benchmark !== ALL_OPTION) form.benchmark = benchmark;
			if (system !== ALL_OPTION) form.system = system;
			if (slice.trim()) form.slice = slice.trim();
			if (resume) form.resume = true;
			return startTestRun(token, form);
		},
		onMutate: () => {
			setDone(null);
			setItems([]);
			setLatest(null);
			setSuiteRunId(null);
			setTotal(0);
			setSkipped(0);
			setStreamError(null);
		},
		onSuccess: () => startStream()
	});

	const cancelMutation = useMutation({ mutationFn: () => cancelTestRun(token) });

	return (
		<div className="flex flex-col gap-4">
			<h2 className="text-lg font-medium">Tests</h2>

			{(runMutation.isError || cancelMutation.isError) && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					{runMutation.error ? 'Failed to start test run' : 'Failed to cancel test run'}
				</div>
			)}

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
				<Button
					onClick={() => runMutation.mutate()}
					disabled={runMutation.isPending || running || !effectiveSuite}
				>
					{runMutation.isPending ? 'Starting…' : 'Run'}
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
						{latest ? `${latest.i}/${latest.total || total} - ${latest.passed} passed` : 'Starting…'}
					</div>
				)}
			</div>

			{streamError && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					{streamError}
				</div>
			)}

			{suiteRunId && (
				<div className="text-muted-foreground text-xs">
					Suite run: <span className="text-foreground">{suiteRunId}</span> · Total: {total} ·
					Skipped: {skipped}
				</div>
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
							{item.reason && (
								<span className="text-muted-foreground max-w-48 truncate">{item.reason}</span>
							)}
						</div>
					))}
					{items.length === 0 && (
						<div className="text-muted-foreground px-2.5 py-4 text-center">No items yet</div>
					)}
				</div>
			</div>

			{done && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2.5 text-xs">
					<span className="text-sm font-medium">Done</span>
					<span className="text-muted-foreground">
						{done.passed} / {done.attempted} passed
					</span>
					{done.cancelled && <Badge variant="secondary">Cancelled</Badge>}
				</div>
			)}
		</div>
	);
}
