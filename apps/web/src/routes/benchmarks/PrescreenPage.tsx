import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ListEmptyState } from '@/components/common/ListChrome';
import { Disclosure } from '@/components/settings/formFields';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusNotice } from '@/components/ui/status-notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	cancelPrescreen,
	getPrescreenDashboard,
	getPrescreenGrids,
	getPrescreenSweep,
	getPrescreenSweeps,
	getServeProfiles,
	type PrescreenStartForm,
	parseBenchmarksEventStream,
	startPrescreen,
	startPrescreenDashboard,
	stopPrescreenDashboard,
	streamPrescreen
} from '@/lib/apis/benchmarks';
import { listProfiles } from '@/lib/apis/benchmarks/profiles';
import { errorMessage } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { shownTime } from '@/lib/utils/dates';
import { ResultActions, StatusBadge, type Tone } from './ResultActions';
import { knobsText } from './resultLinks';

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
	started_at?: number;
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

type Dashboard = { running: boolean; url: string; port: number; last_output?: string | null };

/** DAT-2: a missing value. */
const NONE = '–';

const fmtNum = (n: unknown, digits = 1): string => (typeof n === 'number' ? n.toFixed(digits) : NONE);
const fmtMiB = (n: number | null | undefined): string => (typeof n === 'number' ? n.toLocaleString() : NONE);

/** study.py's GRID_LIMIT: Auto measures every point of a grid this small, and runs TPE trials above it. */
const GRID_LIMIT = 120;

const changesText = (changes: Overrides | undefined): string => knobsText(changes) || "The profile's settings";

const flagsText = (overrides: Overrides | undefined): string => knobsText(overrides);

/** DAT-3: one word and colour per state (models/benchmarks/prescreen.py's statuses). */
const SWEEP_STATUS: Record<string, { label: string; tone: Tone }> = {
	running: { label: 'Running', tone: 'secondary' },
	done: { label: 'Done', tone: 'success' },
	cancelled: { label: 'Cancelled', tone: 'secondary' },
	failed: { label: 'Failed', tone: 'danger' },
	stale: { label: 'Abandoned', tone: 'warning' }
};
const POINT_STATUS: Record<string, { label: string; tone: Tone }> = {
	running: { label: 'Measuring', tone: 'warning' },
	ok: { label: 'Measured', tone: 'success' },
	oom: { label: 'Out of memory', tone: 'danger' },
	load_error: { label: 'Failed to load', tone: 'danger' },
	crash: { label: 'Crashed', tone: 'danger' },
	timeout: { label: 'Timed out', tone: 'danger' },
	parse_error: { label: 'Unreadable output', tone: 'danger' },
	pruned: { label: 'Skipped: pruned', tone: 'secondary' },
	invalid: { label: 'Skipped: invalid', tone: 'secondary' },
	repeat: { label: 'Skipped: repeat', tone: 'secondary' },
	cancelled: { label: 'Cancelled', tone: 'secondary' }
};
/** A load check at the profile's context (CTX_CHECKS). */
const CTX_CHECK: Record<string, { label: string; tone: Tone }> = {
	ok: { label: 'Fits', tone: 'success' },
	oom_at_ctx: { label: 'Out of memory', tone: 'danger' },
	load_error: { label: 'Failed to load', tone: 'danger' },
	timeout: { label: 'Timed out', tone: 'warning' },
	skipped: { label: 'Skipped', tone: 'secondary' }
};
const statusOf = (map: Record<string, { label: string; tone: Tone }>, value: string) =>
	map[value] ?? { label: value, tone: 'danger' as Tone };

const SAMPLER_HELP = {
	auto: `Measures every point of a grid of up to ${GRID_LIMIT} points, after its constraints; runs TPE trials on a larger one.`,
	grid: 'Measures every point of the grid.',
	tpe: "Optuna's TPE sampler proposes the number of trials set below."
} as const;
const OBJECTIVE_HELP = {
	tg: 'Ranks candidates by generation speed (tg).',
	pp: 'Ranks candidates by prompt processing speed (pp).',
	both: 'Ranks candidates by both, as a Pareto front.'
} as const;

type FormField = 'trials' | 'seed' | 'ctxChecks' | 'nPrompt' | 'nGen' | 'reps' | 'pointTimeout';
const FORM_ORDER: readonly FormField[] = ['trials', 'seed', 'ctxChecks', 'nPrompt', 'nGen', 'reps', 'pointTimeout'];
const wholeNumberProblem = (value: string, min: number): string | undefined =>
	/^\d+$/.test(value.trim()) && Number(value) >= min ? undefined : `Enter a whole number of at least ${min}.`;

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
	const [searchParams, setSearchParams] = useSearchParams();
	const sweepParam = searchParams.get('sweep');

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
	const [formOpen, setFormOpen] = useState<boolean | null>(null);

	const problems: Partial<Record<FormField, string>> = {
		trials: sampler === 'grid' ? undefined : wholeNumberProblem(trials, 1),
		seed: wholeNumberProblem(seed, 0),
		ctxChecks: wholeNumberProblem(ctxChecks, 0),
		nPrompt: wholeNumberProblem(nPrompt, 1),
		nGen: wholeNumberProblem(nGen, 1),
		reps: wholeNumberProblem(reps, 1),
		pointTimeout: wholeNumberProblem(pointTimeout, 1)
	};
	const fieldErrors = useFieldErrors(problems, FORM_ORDER);

	const profilesQuery = useQuery({
		queryKey: ['serve-profiles'],
		queryFn: () => getServeProfiles(token),
		enabled: !!token
	});
	const profileEntriesQuery = useQuery({
		queryKey: ['profiles', 'active'],
		queryFn: () => listProfiles(token),
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
	const shownRef = useRef<string | null>(null);

	const stopStreaming = useCallback(() => {
		streamControllerRef.current?.abort();
		streamControllerRef.current = null;
		setStreaming(false);
	}, []);

	// Each response ends after ~30 s while the sweep runs (so an open tab never
	// holds up a backend shutdown), so this reads the sweep again and
	// reconnects for as long as it is running. A stream aborted by show()
	// switching sweeps stops there, without overwriting the new one.
	const stream = useCallback(
		async (sweepId: string) => {
			for (;;) {
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
						if (evt.event === 'done' || evt.event === 'reconnect') break;
						if (evt.data) setDetail(evt.data as Detail);
					}
				} catch (err) {
					if ((err as { name?: string })?.name !== 'AbortError') setDetailError(errorMessage(err));
				} finally {
					setStreaming(false);
					if (streamControllerRef.current === controller) streamControllerRef.current = null;
				}
				if (controller.signal.aborted) return;
				await queryClient.invalidateQueries({ queryKey: ['prescreen-sweeps'] });
				// The last event can predate the sweep's close; read its state again.
				let latest: Detail;
				try {
					latest = (await getPrescreenSweep(token, sweepId)) as Detail;
				} catch (err) {
					setDetailError(errorMessage(err));
					return;
				}
				if (controller.signal.aborted) return;
				setDetail(latest);
				if (latest?.sweep?.status !== 'running' || !latest?.running) return;
			}
		},
		[token, queryClient]
	);

	const show = useCallback(
		async (sweepId: string) => {
			shownRef.current = sweepId;
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

	// The sweep in the address (NAV-1); without one, the running sweep, else the latest.
	// Back and Forward change the address, and the page follows.
	const target = sweepParam ?? sweepsData?.active?.sweep_id ?? sweepsData?.sweeps?.[0]?.sweep_id ?? null;
	useEffect(() => {
		if (target && shownRef.current !== target) void show(target);
	}, [target, show]);
	useEffect(() => stopStreaming, [stopStreaming]);

	/** Opening a sweep is a destination: it adds a history entry (NAV-1). */
	const openSweep = (sweepId: string) => {
		if (sweepId !== sweepParam) setSearchParams({ sweep: sweepId });
		// The address is already there, or the sweep already shown: read it again (a new start).
		if (sweepId === sweepParam || sweepId === shownRef.current) void show(sweepId);
	};

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
			setFormOpen(false);
			if (res?.sweep_id) openSweep(res.sweep_id);
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
	const defaultProfile = profileEntriesQuery.data?.find((e) => e.profile.is_default)?.profile.name;
	const effectiveProfile = profile === DEFAULT_OPTION ? defaultProfile : profile;
	// The default grid is the one named after the profile (#1113: it never resolved before).
	const selectedGrid = gridOptions.find((g) => g.name === (grid === DEFAULT_OPTION ? effectiveProfile : grid));
	const repsNumber = Number(reps) || 0;
	// Auto measures a grid this small point by point, so a trial budget means nothing.
	const autoIsGrid =
		sampler === 'auto' && selectedGrid?.combinations !== undefined && selectedGrid.combinations <= GRID_LIMIT;
	const trialsUnused = sampler === 'grid' || autoIsGrid;
	const loaded = !sweepsQuery.isPending;
	const newSweepOpen = formOpen ?? (loaded && !sweep);
	const sweepStatus = sweep ? statusOf(SWEEP_STATUS, sweep.status) : null;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Pre-screen</h2>
				<p className="text-muted-foreground text-xs">
					Raw llama-bench throughput over a grid of offload and batch flags, to choose which configurations are worth a
					full Tests run. These are not serving measurements, and they never appear on Compare or Report.
				</p>
			</div>

			<Disclosure
				title="New pre-screen"
				description={newSweepOpen ? undefined : 'Choose a profile and grid, then start a pre-screen.'}
				open={newSweepOpen}
				onOpenChange={setFormOpen}
			>
				<form
					noValidate
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (fieldErrors.submit()) startMutation.mutate();
					}}
				>
					<div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
						<SelectBox id="prescreen-profile" label="Profile">
							<Select value={profile} onValueChange={setProfile}>
								<SelectTrigger id="prescreen-profile" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_OPTION}>
										{defaultProfile ? `Default (${defaultProfile})` : 'Default profile'}
									</SelectItem>
									{profileOptions.map((p) => (
										<SelectItem key={p} value={p}>
											{p}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SelectBox>

						<SelectBox
							id="prescreen-grid"
							label="Grid"
							error={selectedGrid?.error ? `${selectedGrid.name}: ${selectedGrid.error}` : undefined}
							help={
								selectedGrid?.combinations !== undefined
									? `${selectedGrid.combinations} combinations before constraints, over ${Object.keys(
											selectedGrid.knobs ?? {}
										)
											.map((k) => k.replace(/^LLAMA_/, '').toLowerCase())
											.join(', ')}; each point runs ${repsNumber} ${repsNumber === 1 ? 'time' : 'times'}.`
									: undefined
							}
						>
							<Select value={grid} onValueChange={setGrid}>
								<SelectTrigger id="prescreen-grid" className="w-full" aria-describedby="prescreen-grid-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_OPTION}>
										{effectiveProfile ? `The profile's (${effectiveProfile})` : "The profile's"}
									</SelectItem>
									{gridOptions.map((g) => (
										<SelectItem key={g.name} value={g.name}>
											{g.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SelectBox>

						<SelectBox id="prescreen-sampler" label="Sampler" help={SAMPLER_HELP[sampler]}>
							<Select value={sampler} onValueChange={(v) => setSampler(v as typeof sampler)}>
								<SelectTrigger id="prescreen-sampler" className="w-full" aria-describedby="prescreen-sampler-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Auto</SelectItem>
									<SelectItem value="grid">Grid</SelectItem>
									<SelectItem value="tpe">TPE</SelectItem>
								</SelectContent>
							</Select>
						</SelectBox>

						<SelectBox id="prescreen-objective" label="Objective" help={OBJECTIVE_HELP[objective]}>
							<Select value={objective} onValueChange={(v) => setObjective(v as typeof objective)}>
								<SelectTrigger id="prescreen-objective" className="w-full" aria-describedby="prescreen-objective-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="tg">Generation</SelectItem>
									<SelectItem value="pp">Prompt processing</SelectItem>
									<SelectItem value="both">Both</SelectItem>
								</SelectContent>
							</Select>
						</SelectBox>
					</div>

					<div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
						<NumberField
							id="prescreen-trials"
							label="Trials"
							value={trials}
							onChange={setTrials}
							disabled={trialsUnused}
							help={
								sampler === 'grid'
									? 'Not used: Grid measures every point.'
									: autoIsGrid
										? `Not used: this grid has ${selectedGrid?.combinations} points, so Auto measures them all.`
										: 'How many points TPE measures.'
							}
							error={trialsUnused ? undefined : fieldErrors.errors.trials}
							field={fieldErrors.field('trials')}
						/>
						<NumberField
							id="prescreen-seed"
							label="Seed"
							value={seed}
							onChange={setSeed}
							help="Fixes the order TPE proposes points in."
							error={fieldErrors.errors.seed}
							field={fieldErrors.field('seed')}
						/>
						<NumberField
							id="prescreen-ctx-checks"
							label="Load checks"
							value={ctxChecks}
							onChange={setCtxChecks}
							help="How many leaders to start in llama-server at the profile's context, to see that they fit."
							error={fieldErrors.errors.ctxChecks}
							field={fieldErrors.field('ctxChecks')}
						/>
						<NumberField
							id="prescreen-point-timeout"
							label="Point timeout, s"
							value={pointTimeout}
							onChange={setPointTimeout}
							help="A point still running after this long is stopped."
							error={fieldErrors.errors.pointTimeout}
							field={fieldErrors.field('pointTimeout')}
						/>
						<NumberField
							id="prescreen-n-prompt"
							label="Prompt tokens (-p)"
							value={nPrompt}
							onChange={setNPrompt}
							error={fieldErrors.errors.nPrompt}
							field={fieldErrors.field('nPrompt')}
						/>
						<NumberField
							id="prescreen-n-gen"
							label="Generated tokens (-n)"
							value={nGen}
							onChange={setNGen}
							error={fieldErrors.errors.nGen}
							field={fieldErrors.field('nGen')}
						/>
						<NumberField
							id="prescreen-reps"
							label="Repetitions (-r)"
							value={reps}
							onChange={setReps}
							error={fieldErrors.errors.reps}
							field={fieldErrors.field('reps')}
						/>
					</div>

					<div className="flex flex-col gap-2">
						<div>
							<Button type="submit" disabled={startMutation.isPending || running} aria-busy={startMutation.isPending}>
								<PlayIcon aria-hidden data-icon="inline-start" />
								{startMutation.isPending ? 'Starting…' : 'Start pre-screen'}
							</Button>
						</div>
						{running && (
							<FieldMessage id="prescreen-start-help" help="A pre-screen is running. Cancel it to start another." />
						)}
						{startMutation.isError && (
							<FieldMessage id="prescreen-start-error" error={errorMessage(startMutation.error)} />
						)}
					</div>
				</form>
			</Disclosure>

			{sweepsData?.last_error && (
				<StatusNotice tone="danger" title="The last pre-screen failed" details={sweepsData.last_error}>
					<p>Check the profile and its grid, then start it again.</p>
				</StatusNotice>
			)}

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
				{!dashboard?.running && dashboard?.last_output && (
					<pre className="text-muted-foreground w-full text-xs whitespace-pre-wrap">
						Its last output: {dashboard.last_output}
					</pre>
				)}
				{dashboardMutation.isError && (
					<FieldMessage
						id="prescreen-dashboard-error"
						className="basis-full"
						error={errorMessage(dashboardMutation.error)}
					/>
				)}
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-0 grow basis-72 flex-col gap-1">
					<Label htmlFor="prescreen-sweep">Pre-screen</Label>
					<Select
						value={sweep?.sweep_id ?? ''}
						disabled={sweeps.length === 0}
						onValueChange={(val) => val && openSweep(val)}
					>
						<SelectTrigger id="prescreen-sweep" className="w-full">
							<SelectValue placeholder={sweepsQuery.isLoading ? 'Loading…' : 'None recorded'} />
						</SelectTrigger>
						<SelectContent>
							{sweeps.map((s) => (
								<SelectItem key={s.sweep_id} value={s.sweep_id}>
									{typeof s.started_at === 'number' ? shownTime(s.started_at).exact : s.sweep_id} · {s.profile} ·{' '}
									{s.sampler} / {s.objective} · {statusOf(SWEEP_STATUS, s.status).label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
					<AlertDialogTrigger asChild>
						<Button type="button" variant="outline" disabled={cancelMutation.isPending || !running}>
							{cancelMutation.isPending ? 'Cancelling…' : 'Cancel pre-screen'}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Cancel pre-screen</AlertDialogTitle>
							<AlertDialogDescription>
								The point being measured is stopped and recorded as cancelled. Points already measured are kept, and the
								study stays readable in the dashboard.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Keep running</AlertDialogCancel>
							<AlertDialogAction onClick={() => cancelMutation.mutate()}>Cancel pre-screen</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				{streaming && (
					<span className="flex items-center gap-1 pb-2 text-xs text-success">
						<span className="size-1.5 animate-pulse rounded-full bg-success" />
						Live
					</span>
				)}
			</div>

			{running && active?.current && (
				<StatusNotice
					tone="pending"
					title={`${active.current.phase === 'ctx_check' ? 'Load-checking' : 'Measuring'} point ${active.current.point_id}: ${flagsText(active.current.overrides)}`}
				/>
			)}

			{detailError && (
				<StatusNotice tone="danger" title="Couldn't load the pre-screen">
					<p>{detailError}</p>
				</StatusNotice>
			)}

			{!sweep ? (
				loaded &&
				!detailError && (
					<ListEmptyState
						title="No pre-screens yet"
						description="A pre-screen times llama-bench over the profile's grid, to pick the settings worth a full Tests run. Choose a profile under New pre-screen, then start it."
					/>
				)
			) : (
				<>
					<div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
						<StatTile
							label="Status"
							value={sweepStatus && <StatusBadge label={sweepStatus.label} tone={sweepStatus.tone} />}
						/>
						<StatTile label="Profile / grid" value={`${sweep.profile} / ${sweep.grid_path}`} />
						<StatTile label="Sampler / objective" value={`${sweep.sampler} / ${sweep.objective}`} />
						<StatTile label="Study" value={sweep.study_name} />
						<StatTile label="Model" value={sweep.model_file} />
						<StatTile
							label="llama.cpp build"
							value={sweep.build_commit ? `${sweep.build_commit} (${sweep.build_number ?? '?'})` : NONE}
						/>
						<StatTile label="GPU / driver" value={`${sweep.gpu_info ?? NONE} / ${sweep.driver_version ?? NONE}`} />
						<StatTile label="-p / -n / -r" value={`${sweep.n_prompt} / ${sweep.n_gen} / ${sweep.reps}`} />
					</div>
					{sweep.status_reason && <p className="text-muted-foreground text-xs">Reason: {sweep.status_reason}</p>}

					<section className="flex flex-col gap-1">
						<h3 className="text-sm font-medium">
							Candidates, raw llama-bench throughput (not a serving measurement): confirm with a full Tests run
						</h3>
						<Table aria-label="Candidates">
							<TableHeader>
								<TableRow>
									<TableHead className="text-right">#</TableHead>
									<TableHead>Changes from the profile</TableHead>
									<TableHead className="text-right">Generation, tokens/s</TableHead>
									<TableHead className="text-right">Prompt, tokens/s</TableHead>
									<TableHead className="text-right">Runs</TableHead>
									<TableHead className="text-right">Peak VRAM, MiB</TableHead>
									<TableHead>Load at the profile's context</TableHead>
									<TableHead>Use it</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{candidates.map((c) => {
									const check = c.ctx_check ? statusOf(CTX_CHECK, c.ctx_check) : null;
									return (
										<TableRow key={c.point_id}>
											<TableCell className="text-muted-foreground text-right">{c.rank}</TableCell>
											<TableCell>
												{changesText(c.changes)}
												{c.is_baseline && (
													<Badge variant="secondary" className="ms-2">
														Baseline
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-right">{fmtNum(c.tg, 2)}</TableCell>
											<TableCell className="text-right">{fmtNum(c.pp, 1)}</TableCell>
											<TableCell className="text-right">{c.measurements}</TableCell>
											<TableCell className="text-right">{fmtMiB(c.peak_vram_mib)}</TableCell>
											<TableCell>
												{check ? (
													<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
														<StatusBadge label={check.label} tone={check.tone} />
														{c.ctx_check_free_mib != null && (
															<span className="text-muted-foreground text-dense">
																({c.ctx_check_free_mib.toLocaleString()} MiB free)
															</span>
														)}
														{c.ctx_check_reason && (
															<span className="text-muted-foreground text-dense">{c.ctx_check_reason}</span>
														)}
													</span>
												) : (
													<span className="text-muted-foreground">Not checked</span>
												)}
											</TableCell>
											<TableCell>
												{c.is_baseline ? (
													<span className="text-muted-foreground">{NONE}</span>
												) : (
													<ResultActions
														profile={sweep.profile}
														overrides={c.changes}
														note={`From pre-screen ${sweep.sweep_id}, candidate ${c.rank}: ${changesText(c.changes)}`}
														size="sm"
														label={`candidate ${c.rank}`}
														showNote={false}
													/>
												)}
											</TableCell>
										</TableRow>
									);
								})}
								{candidates.length === 0 && (
									<TableRow>
										<TableCell colSpan={8} className="text-muted-foreground text-center">
											No point measured yet
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
						<p className="text-muted-foreground mt-1 text-xs">
							Serve with these overrides fills the Serve form with the GPU layers and threads a candidate changes;
							Create profile version opens the profile's Edit form with all of them (batch, micro-batch, MoE layers).
							Nothing starts or is saved until you do it there.
						</p>
					</section>

					<section className="flex flex-col gap-1">
						<h3 className="text-sm font-medium">Points ({points.length})</h3>
						<Table aria-label="Points">
							<TableHeader>
								<TableRow>
									<TableHead className="text-right">Point</TableHead>
									<TableHead className="text-right">Trial</TableHead>
									<TableHead>Phase</TableHead>
									<TableHead>Flags</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Generation, tokens/s</TableHead>
									<TableHead className="text-right">Prompt, tokens/s</TableHead>
									<TableHead className="text-right">Peak VRAM, MiB</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{points.map((p) => {
									const state = statusOf(POINT_STATUS, p.status);
									return (
										<TableRow key={p.point_id}>
											<TableCell className="text-muted-foreground text-right">{p.point_id}</TableCell>
											<TableCell className="text-right">{p.optuna_trial_number ?? NONE}</TableCell>
											<TableCell>{p.phase === 'remeasure' ? `again (${p.remeasure_of})` : p.phase}</TableCell>
											<TableCell className="text-xs">{flagsText(p.overrides)}</TableCell>
											<TableCell>
												<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
													<StatusBadge label={state.label} tone={state.tone} />
													{p.reason && <span className="text-muted-foreground text-xs">{p.reason}</span>}
												</span>
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
											<TableCell className="text-right">{fmtMiB(p.peak_vram_mib)}</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</section>
				</>
			)}
		</div>
	);
}

function SelectBox({
	id,
	label,
	help,
	error,
	children
}: {
	id: string;
	label: string;
	help?: string;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			{children}
			<FieldMessage id={`${id}-help`} help={help} error={error} />
		</div>
	);
}

function NumberField({
	id,
	label,
	value,
	onChange,
	help,
	error,
	disabled,
	field
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
	help?: string;
	error?: string;
	disabled?: boolean;
	field: { ref: (el: HTMLElement | null) => void; onBlur: () => void };
}) {
	const message = `${id}-message`;
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				inputMode="numeric"
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				{...field}
				{...fieldProps(message, { error, help })}
			/>
			<FieldMessage id={message} error={error} help={help} />
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
