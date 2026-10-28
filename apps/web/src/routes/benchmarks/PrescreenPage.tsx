import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	cancelPrescreen,
	getPrescreenDashboard,
	getPrescreenGrids,
	getPrescreenSweep,
	getPrescreenSweeps,
	getServeProfiles,
	parseBenchmarksEventStream,
	type PrescreenStartForm,
	startPrescreen,
	startPrescreenDashboard,
	stopPrescreenDashboard,
	streamPrescreen
} from '@/lib/apis/benchmarks';
import { errorMessage } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';

const DEFAULT_OPTION = '__default__';

type Overrides = Record<string, string>;

type Grid = {
	name: string;
	profile?: string;
	knobs?: Record<string, unknown[]>;
	combinations?: number;
	error?: string;
};

type Sweep = {
	sweep_id: string;
	status: string;
	status_reason: string | null;
	profile: string;
	sampler: string;
	objective: string;
	study_name: string;
	grid_path: string;
	model_file: string;
	build_commit: string | null;
	build_number: number | null;
	gpu_info: string | null;
	driver_version: string | null;
	n_prompt: number;
	n_gen: number;
	reps: number;
};

type Point = {
	point_id: number;
	phase: string;
	optuna_trial_number: number | null;
	remeasure_of: number | null;
	overrides: Overrides;
	status: string;
	reason: string | null;
	tg_avg_ts: number | null;
	tg_stddev_ts: number | null;
	pp_avg_ts: number | null;
	pp_stddev_ts: number | null;
	peak_vram_mib: number | null;
};

type Candidate = {
	point_id: number;
	rank: number;
	is_baseline: boolean;
	changes: Overrides;
	tg: number;
	pp: number;
	measurements: number;
	peak_vram_mib: number | null;
	ctx_check: string | null;
	ctx_check_free_mib: number | null;
	ctx_check_reason: string | null;
};

type Active = { sweep_id: string; current: { point_id: number; phase: string; overrides: Overrides } | null };

type State = { running: boolean; active: Active | null; last_error: string | null };

type Detail = State & { sweep: Sweep; points: Point[]; candidates: Candidate[] };

type Sweeps = State & { sweeps: Sweep[] };

type Dashboard = { running: boolean; url: string; port: number };

const fmtNum = (n: unknown, digits = 1): string => (typeof n === 'number' ? n.toFixed(digits) : '—');

// The Serve page takes these as one-off overrides; anything else a candidate
// changes needs a new profile version.
const SERVE_OVERRIDES = new Set(['ngl', 'threads']);

const changesText = (changes: Overrides | undefined): string => {
	const entries = Object.entries(changes ?? {});
	return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : '(profile defaults)';
};

const flagsText = (overrides: Overrides | undefined): string =>
	Object.entries(overrides ?? {})
		.map(([k, v]) => `${k.replace(/^LLAMA_/, '').toLowerCase()} ${v}`)
		.join(', ');

const statusTone: Record<string, string> = {
	ok: 'text-green-600 dark:text-green-400',
	oom: 'text-red-600 dark:text-red-400',
	pruned: 'text-muted-foreground',
	invalid: 'text-muted-foreground',
	repeat: 'text-muted-foreground',
	running: 'text-yellow-700 dark:text-yellow-400'
};

/**
 * Benchmarks > Pre-screen: llama-bench over a grid of offload and batch
 * flags, one process per point, chosen by an Optuna study
 * (benchmarks/prescreen/ in the backend). The numbers are raw llama-bench
 * throughput at a test-sized context, so the page says so on the candidate
 * table and never offers them for comparison with a served run. A running
 * sweep streams its whole detail every ~2 s; each event replaces the shown
 * detail, as the Tune page's status does.
 */
export function PrescreenPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();

	const [profile, setProfile] = useState(DEFAULT_OPTION);
	const [grid, setGrid] = useState(DEFAULT_OPTION);
	const [sampler, setSampler] = useState<'auto' | 'grid' | 'tpe'>('auto');
	const [objective, setObjective] = useState<'tg' | 'pp' | 'both'>('tg');
	const [trials, setTrials] = useState('40');
	const [seed, setSeed] = useState('0');
	const [ctxChecks, setCtxChecks] = useState('3');
	const [pointTimeout, setPointTimeout] = useState('900');
	const [nPrompt, setNPrompt] = useState('512');
	const [nGen, setNGen] = useState('128');
	const [reps, setReps] = useState('5');
	const [showCancelConfirm, setShowCancelConfirm] = useState(false);

	const profilesQuery = useQuery({
		queryKey: ['serve-profiles'],
		queryFn: () => getServeProfiles(token),
		enabled: !!token
	});
	const gridsQuery = useQuery({
		queryKey: ['prescreen-grids'],
		queryFn: () => getPrescreenGrids(token),
		enabled: !!token
	});
	const sweepsQuery = useQuery({
		queryKey: ['prescreen-sweeps'],
		queryFn: () => getPrescreenSweeps(token, 20),
		enabled: !!token
	});
	const dashboardQuery = useQuery({
		queryKey: ['prescreen-dashboard'],
		queryFn: () => getPrescreenDashboard(token),
		enabled: !!token
	});
	const profileOptions: string[] = profilesQuery.data?.profiles ?? [];
	const gridOptions: Grid[] = gridsQuery.data?.grids ?? [];
	const sweepsData = sweepsQuery.data as Sweeps | undefined;
	const sweeps = sweepsData?.sweeps ?? [];
	const dashboard = dashboardQuery.data as Dashboard | undefined;

	// -------------------------------------------------------------------
	// The sweep shown: streamed while it runs, read once otherwise
	// -------------------------------------------------------------------
	const [detail, setDetail] = useState<Detail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [streaming, setStreaming] = useState(false);
	const streamControllerRef = useRef<AbortController | null>(null);

	const stopStreaming = useCallback(() => {
		streamControllerRef.current?.abort();
		streamControllerRef.current = null;
		setStreaming(false);
	}, []);

	const stream = useCallback(
		async (sweepId: string) => {
			let res: Response | null;
			let controller: AbortController;
			try {
				[res, controller] = await streamPrescreen(token, sweepId);
			} catch (err) {
				setDetailError(errorMessage(err));
				return;
			}
			if (!res?.ok || !res.body) {
				setDetailError('Failed to start the live stream');
				return;
			}
			streamControllerRef.current = controller;
			setStreaming(true);
			try {
				for await (const evt of parseBenchmarksEventStream(res.body)) {
					if (evt.event === 'done') break;
					if (evt.data) setDetail(evt.data as Detail);
				}
			} catch (err) {
				if ((err as { name?: string })?.name !== 'AbortError') setDetailError(errorMessage(err));
			} finally {
				setStreaming(false);
				streamControllerRef.current = null;
				await queryClient.invalidateQueries({ queryKey: ['prescreen-sweeps'] });
			}
			// The last event can predate the sweep's close; read the final state once.
			try {
				setDetail(await getPrescreenSweep(token, sweepId));
			} catch (err) {
				setDetailError(errorMessage(err));
			}
		},
		[token, queryClient]
	);

	const show = useCallback(
		async (sweepId: string) => {
			stopStreaming();
			setDetailError(null);
			try {
				const d = (await getPrescreenSweep(token, sweepId)) as Detail;
				setDetail(d);
				if (d?.sweep?.status === 'running' && d?.running) void stream(sweepId);
			} catch (err) {
				setDetailError(errorMessage(err));
			}
		},
		[token, stopStreaming, stream]
	);

	// On arrival: the running sweep if there is one, else the latest.
	const shownOnce = useRef(false);
	useEffect(() => {
		if (shownOnce.current || !sweepsData) return;
		shownOnce.current = true;
		const first = sweepsData.active?.sweep_id ?? sweepsData.sweeps?.[0]?.sweep_id;
		if (first) void show(first);
	}, [sweepsData, show]);
	useEffect(() => stopStreaming, [stopStreaming]);

	const startMutation = useMutation({
		mutationFn: () => {
			const form: PrescreenStartForm = {
				profile: profile === DEFAULT_OPTION ? undefined : profile,
				grid: grid === DEFAULT_OPTION ? undefined : grid,
				sampler,
				objective,
				trials: Number(trials),
				seed: Number(seed),
				ctx_checks: Number(ctxChecks),
				point_timeout: Number(pointTimeout),
				n_prompt: Number(nPrompt),
				n_gen: Number(nGen),
				reps: Number(reps)
			};
			return startPrescreen(token, form);
		},
		onSuccess: async (res: { sweep_id?: string } | null) => {
			await queryClient.invalidateQueries({ queryKey: ['prescreen-sweeps'] });
			if (res?.sweep_id) void show(res.sweep_id);
		}
	});

	const cancelMutation = useMutation({
		mutationFn: () => cancelPrescreen(token),
		onError: (err) => setDetailError(errorMessage(err))
	});

	const dashboardMutation = useMutation({
		mutationFn: (start: boolean) => (start ? startPrescreenDashboard(token) : stopPrescreenDashboard(token)),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['prescreen-dashboard'] })
	});

	const running = detail?.running === true || sweepsData?.running === true;
	const sweep = detail?.sweep;
	const active = detail?.active ?? sweepsData?.active;
	const candidates = detail?.candidates ?? [];
	const points = detail?.points ?? [];
	const selectedGrid = gridOptions.find((g) => g.name === (grid === DEFAULT_OPTION ? profile : grid));

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Pre-screen</h2>
				<p className="text-muted-foreground text-xs">
					Raw llama-bench throughput over a grid of offload and batch flags, to choose which configurations are worth a
					full Tests run. These are not serving measurements, and they never appear on Compare or Report.
				</p>
			</div>

			<form
				className="bg-muted/50 flex flex-col gap-3 rounded-lg p-3"
				onSubmit={(e) => {
					e.preventDefault();
					startMutation.mutate();
				}}
			>
				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1">
						<Label>Profile</Label>
						<Select value={profile} onValueChange={setProfile}>
							<SelectTrigger className="w-40" aria-label="Profile">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
								{profileOptions.map((p) => (
									<SelectItem key={p} value={p}>
										{p}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<Label>Grid</Label>
						<Select value={grid} onValueChange={setGrid}>
							<SelectTrigger className="w-40" aria-label="Grid">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_OPTION}>The profile's</SelectItem>
								{gridOptions.map((g) => (
									<SelectItem key={g.name} value={g.name}>
										{g.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<Label>Sampler</Label>
						<Select value={sampler} onValueChange={(v) => setSampler(v as typeof sampler)}>
							<SelectTrigger className="w-44" aria-label="Sampler">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Auto (grid up to 120 points)</SelectItem>
								<SelectItem value="grid">Grid: every point</SelectItem>
								<SelectItem value="tpe">TPE: a trial budget</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<Label>Objective</Label>
						<Select value={objective} onValueChange={(v) => setObjective(v as typeof objective)}>
							<SelectTrigger className="w-44" aria-label="Objective">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="tg">Generation (tg)</SelectItem>
								<SelectItem value="pp">Prompt processing (pp)</SelectItem>
								<SelectItem value="both">Both (Pareto front)</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<NumberField id="prescreen-trials" label="Trials (TPE)" value={trials} onChange={setTrials} min={1} />
					<NumberField id="prescreen-seed" label="Seed" value={seed} onChange={setSeed} min={0} />
					<NumberField
						id="prescreen-ctx-checks"
						label="Load checks"
						value={ctxChecks}
						onChange={setCtxChecks}
						min={0}
					/>
				</div>

				<div className="flex flex-wrap items-end gap-3">
					<NumberField
						id="prescreen-n-prompt"
						label="Prompt tokens (-p)"
						value={nPrompt}
						onChange={setNPrompt}
						min={1}
					/>
					<NumberField id="prescreen-n-gen" label="Generated tokens (-n)" value={nGen} onChange={setNGen} min={1} />
					<NumberField id="prescreen-reps" label="Repetitions (-r)" value={reps} onChange={setReps} min={1} />
					<NumberField
						id="prescreen-point-timeout"
						label="Point timeout (s)"
						value={pointTimeout}
						onChange={setPointTimeout}
						min={1}
					/>

					<Button type="submit" disabled={startMutation.isPending || running}>
						{startMutation.isPending ? 'Starting…' : 'Start'}
					</Button>

					<AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
						<AlertDialogTrigger asChild>
							<Button type="button" variant="destructive" disabled={cancelMutation.isPending || !running}>
								{cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Cancel pre-screen</AlertDialogTitle>
								<AlertDialogDescription>
									The point being measured is stopped and recorded as cancelled. Points already measured are kept, and
									the study stays readable in the dashboard.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Keep running</AlertDialogCancel>
								<AlertDialogAction onClick={() => cancelMutation.mutate()}>Cancel pre-screen</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>

				{selectedGrid?.combinations !== undefined && (
					<p className="text-muted-foreground text-xs">
						{selectedGrid.name}: {selectedGrid.combinations} combinations before constraints, over{' '}
						{Object.keys(selectedGrid.knobs ?? {})
							.map((k) => k.replace(/^LLAMA_/, '').toLowerCase())
							.join(', ')}
						.
					</p>
				)}
				{startMutation.isError && <ErrorBox>{errorMessage(startMutation.error)}</ErrorBox>}
				{sweepsData?.last_error && <ErrorBox>Pre-screen failed: {sweepsData.last_error}</ErrorBox>}
			</form>

			{/* optuna-dashboard */}
			<div className="bg-muted/50 flex flex-wrap items-center gap-3 rounded-lg p-3 text-sm">
				<span className="font-medium">Optuna dashboard</span>
				{dashboard?.running ? (
					<a className="text-primary underline" href={dashboard.url} target="_blank" rel="noreferrer">
						{dashboard.url}
					</a>
				) : (
					<span className="text-muted-foreground">stopped</span>
				)}
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={dashboardMutation.isPending}
					onClick={() => dashboardMutation.mutate(!dashboard?.running)}
				>
					{dashboard?.running ? 'Stop dashboard' : 'Start dashboard'}
				</Button>
				<span className="text-muted-foreground text-xs">
					Loopback only ({dashboard?.port ?? 8091}): it has no authentication. From another machine, use{' '}
					<code>
						ssh -L {dashboard?.port ?? 8091}:127.0.0.1:{dashboard?.port ?? 8091}
					</code>
					.
				</span>
				{dashboardMutation.isError && <ErrorBox>{errorMessage(dashboardMutation.error)}</ErrorBox>}
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-64 grow flex-col gap-1">
					<Label>Sweeps</Label>
					<Select value={sweep?.sweep_id ?? ''} onValueChange={(val) => val && void show(val)}>
						<SelectTrigger className="w-full" aria-label="Sweeps">
							<SelectValue placeholder={sweepsQuery.isLoading ? 'Loading…' : 'Select a sweep'} />
						</SelectTrigger>
						<SelectContent>
							{sweeps.map((s) => (
								<SelectItem key={s.sweep_id} value={s.sweep_id}>
									{s.sweep_id} — {s.profile} / {s.sampler} / {s.objective} ({s.status})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{streaming && (
					<span className="flex items-center gap-1 pb-2 text-xs text-green-600 dark:text-green-400">
						<span className="size-1.5 animate-pulse rounded-full bg-green-500" />
						Live
					</span>
				)}
			</div>

			{running && active?.current && (
				<div className="flex items-center gap-1.5 rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
					<span className="size-1.5 animate-pulse rounded-full bg-yellow-500" />
					{active.current.phase === 'ctx_check' ? 'Load-checking' : 'Measuring'} point {active.current.point_id}:{' '}
					{flagsText(active.current.overrides)}
				</div>
			)}

			{detailError && <ErrorBox>{detailError}</ErrorBox>}

			{!sweep ? (
				<p className="text-muted-foreground my-4 text-sm">No pre-screen to show yet.</p>
			) : (
				<>
					<div className="grid gap-3 text-sm sm:grid-cols-2 md:grid-cols-4">
						<StatTile label="Status" value={sweep.status} />
						<StatTile label="Profile / grid" value={`${sweep.profile} / ${sweep.grid_path}`} />
						<StatTile label="Sampler / objective" value={`${sweep.sampler} / ${sweep.objective}`} />
						<StatTile label="Study" value={sweep.study_name} />
						<StatTile label="Model" value={sweep.model_file} />
						<StatTile
							label="llama.cpp build"
							value={sweep.build_commit ? `${sweep.build_commit} (${sweep.build_number ?? '?'})` : '—'}
						/>
						<StatTile label="GPU / driver" value={`${sweep.gpu_info ?? '—'} / ${sweep.driver_version ?? '—'}`} />
						<StatTile label="-p / -n / -r" value={`${sweep.n_prompt} / ${sweep.n_gen} / ${sweep.reps}`} />
					</div>
					{sweep.status_reason && <p className="text-muted-foreground text-xs">Reason: {sweep.status_reason}</p>}

					<div>
						<div className="mb-1 px-0.5 text-xs font-medium">
							Candidates, raw llama-bench throughput (not a serving measurement): confirm with a full Tests run
						</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="text-right">#</TableHead>
									<TableHead>Changes from the profile</TableHead>
									<TableHead className="text-right">tg t/s</TableHead>
									<TableHead className="text-right">pp t/s</TableHead>
									<TableHead className="text-right">Runs</TableHead>
									<TableHead className="text-right">Peak VRAM MiB</TableHead>
									<TableHead>Load at context</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{candidates.map((c) => (
									<TableRow key={c.point_id} className={c.is_baseline ? 'bg-blue-500/5' : undefined}>
										<TableCell className="text-muted-foreground text-right">{c.rank}</TableCell>
										<TableCell>
											{changesText(c.changes)}
											{c.is_baseline && <span className="text-blue-600 dark:text-blue-400"> (baseline)</span>}
										</TableCell>
										<TableCell className="text-right">{fmtNum(c.tg, 2)}</TableCell>
										<TableCell className="text-right">{fmtNum(c.pp, 1)}</TableCell>
										<TableCell className="text-right">{c.measurements}</TableCell>
										<TableCell className="text-right">{c.peak_vram_mib ?? '—'}</TableCell>
										<TableCell>
											{c.ctx_check ?? '—'}
											{c.ctx_check_free_mib != null && (
												<span className="text-muted-foreground"> ({c.ctx_check_free_mib} MiB free)</span>
											)}
											{c.ctx_check_reason && <span className="text-muted-foreground"> — {c.ctx_check_reason}</span>}
										</TableCell>
									</TableRow>
								))}
								{candidates.length === 0 && (
									<TableRow>
										<TableCell colSpan={7} className="text-muted-foreground text-center">
											No point measured yet
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
						<p className="text-muted-foreground mt-1 text-xs">
							{[...SERVE_OVERRIDES].join(' and ')} are Serve page overrides; anything else a candidate changes (batch,
							ubatch, moe) needs a new profile version, from Serve's profile list.
						</p>
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Points ({points.length})</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="text-right">Point</TableHead>
									<TableHead className="text-right">Trial</TableHead>
									<TableHead>Phase</TableHead>
									<TableHead>Flags</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">tg t/s</TableHead>
									<TableHead className="text-right">pp t/s</TableHead>
									<TableHead className="text-right">Peak VRAM MiB</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{points.map((p) => (
									<TableRow key={p.point_id}>
										<TableCell className="text-muted-foreground text-right">{p.point_id}</TableCell>
										<TableCell className="text-right">{p.optuna_trial_number ?? '—'}</TableCell>
										<TableCell>{p.phase === 'remeasure' ? `again (${p.remeasure_of})` : p.phase}</TableCell>
										<TableCell className="text-xs">{flagsText(p.overrides)}</TableCell>
										<TableCell>
											<span className={statusTone[p.status] ?? 'text-red-600 dark:text-red-400'}>{p.status}</span>
											{p.reason && <span className="text-muted-foreground text-xs"> — {p.reason}</span>}
										</TableCell>
										<TableCell className="text-right">
											{fmtNum(p.tg_avg_ts, 2)}
											{p.tg_stddev_ts != null && (
												<span className="text-muted-foreground"> ± {fmtNum(p.tg_stddev_ts, 2)}</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											{fmtNum(p.pp_avg_ts, 1)}
											{p.pp_stddev_ts != null && (
												<span className="text-muted-foreground"> ± {fmtNum(p.pp_stddev_ts, 1)}</span>
											)}
										</TableCell>
										<TableCell className="text-right">{p.peak_vram_mib ?? '—'}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</>
			)}
		</div>
	);
}

function NumberField({
	id,
	label,
	value,
	onChange,
	min
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
	min: number;
}) {
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				className="w-28"
				type="number"
				min={min}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

function ErrorBox({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
			{children}
		</div>
	);
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="bg-muted/50 rounded-lg p-2.5">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="truncate font-medium">{value}</div>
		</div>
	);
}
