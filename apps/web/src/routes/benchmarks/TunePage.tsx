import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { PlayIcon } from 'lucide-react';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Gone } from '@/components/common/Gone';
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
import { Checkbox } from '@/components/ui/checkbox';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusNotice } from '@/components/ui/status-notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	getRecentSweeps,
	getServeProfiles,
	getTestOptions,
	getTuneGrids,
	getTuneStatus,
	parseBenchmarksEventStream,
	resumeTune,
	startTune,
	stopTune,
	streamTuneLog
} from '@/lib/apis/benchmarks';
import { listProfiles } from '@/lib/apis/benchmarks/profiles';
// The helpers throw the server's detail as a string; errorMessage reads any shape (#143).
import { errorBody, errorMessage } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { shownTime } from '@/lib/utils/dates';
import { ResultActions, StatusBadge, type Tone } from './ResultActions';
import { knobsText } from './resultLinks';

const DEFAULT_OPTION = '__default__';
/** DAT-2: a missing value. */
const NONE = '–';

/** B-D1: tiers by cost, cheapest first, whatever order the server lists them in. */
const TIER_ORDER = ['smoke', 'standard', 'full'];

/** What each budget mode allows (tuning/tune_schedule.py's MODES). */
const BUDGETS: Record<string, { label: string; candidates: number; roundItems: number; help: string }> = {
	interactive: { label: 'Interactive', candidates: 6, roundItems: 6, help: 'Up to 2 hours, 6 candidates.' },
	overnight: { label: 'Overnight', candidates: 16, roundItems: 8, help: 'Up to 8 hours, 16 candidates.' },
	multiday: {
		label: 'Multi-day',
		candidates: 32,
		roundItems: 8,
		help: 'No time limit: it runs until the tier is used up, resumed by hand. 32 candidates.'
	},
	trials: { label: 'Trials', candidates: 4, roundItems: 6, help: 'At most 24 visits, 4 candidates: a short check.' }
};

const fmtNum = (n: unknown, digits = 1): string => (typeof n === 'number' ? n.toFixed(digits) : NONE);
const fmtPercent = (n: unknown): string => (typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : NONE);

const fmtElapsed = (seconds: unknown): string => {
	if (typeof seconds !== 'number') return NONE;
	const s = Math.floor(seconds);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
};

/** A candidate's speed against the baseline: the server's `+33.6%`, or worked out from the log ratio. */
const speedVsBaseline = (c: { score?: unknown; score_pct?: unknown }): string => {
	if (typeof c.score_pct === 'string' && c.score_pct !== '-') return c.score_pct;
	if (typeof c.score === 'number') {
		const pct = Math.expm1(c.score) * 100;
		return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
	}
	return NONE;
};

const candidateName = (c: { label?: string; config_id?: string | null; candidate_sha?: string }): string =>
	c.label || c.config_id || c.candidate_sha || '(unnamed)';

/** A sweep's verdict as a status (COL-3, DAT-3); `null` while it runs. */
const VERDICTS: Record<string, { label: string; tone: Tone }> = {
	adopted: { label: 'Adopted', tone: 'success' },
	rejected: { label: 'No change', tone: 'secondary' },
	indeterminate: { label: 'No verdict', tone: 'warning' },
	incomplete: { label: 'Incomplete', tone: 'warning' },
	running: { label: 'In progress', tone: 'secondary' },
	// No verdict, and no sweep task alive in this backend: a backend that died mid-sweep cut it off.
	interrupted: { label: 'Interrupted', tone: 'warning' }
};

/** A round's stage, a pause's cause and its outcome in words (WRD-2; models/benchmarks/tune.py). */
const STAGES: Record<string, string> = { explore: 'Explore the grid', refine: 'Refine the leader' };
const PAUSE_TRIGGERS: Record<string, string> = {
	drift: "The baseline's speed drifted",
	cliff: 'Speed collapsed during a visit',
	regime: 'The GPU changed speed regime'
};
const PAUSE_RESOLUTIONS: Record<string, string> = {
	recovered: 'Recovered',
	timeout: 'Timed out',
	abandoned: 'Abandoned'
};
/** A code in words, or the code itself when it is new to this page (never blank). */
export const inWords = (map: Record<string, string>, code: string | null | undefined): string =>
	code ? (map[code] ?? code) : NONE;

/** A candidate's state (models/benchmarks/tune.py's CANDIDATE_STATUSES). */
const CANDIDATE_STATUSES: Record<string, { label: string; tone: Tone }> = {
	pending: { label: 'Waiting', tone: 'secondary' },
	active: { label: 'Still in', tone: 'secondary' },
	eliminated: { label: 'Eliminated', tone: 'secondary' },
	infeasible: { label: "Couldn't run", tone: 'danger' },
	marginal: { label: 'Marginal', tone: 'warning' },
	winner: { label: 'Winner', tone: 'success' },
	rejected: { label: 'Rejected', tone: 'danger' }
};

/**
 * The sweep picker's words for one sweep: "2026-11-13 20:15 · qwen38 / smoke · Adopted".
 * A sweep with no verdict is in progress only while a sweep task is alive (`live`).
 */
export const sweepOptionLabel = (
	s: {
		sweep_id: string;
		started_at?: number;
		profile?: string | null;
		tier?: string | null;
		verdict?: string | null;
	},
	live = true
): string => {
	const when = typeof s.started_at === 'number' ? shownTime(s.started_at).exact : s.sweep_id;
	const key = s.verdict ?? 'running';
	const verdict = VERDICTS[key === 'running' && !live ? 'interrupted' : key]?.label ?? s.verdict;
	return `${when} · ${s.profile ?? NONE} / ${s.tier ?? NONE} · ${verdict}`;
};

type Knobs = Record<string, unknown>;
type TuneCandidate = {
	candidate_sha?: string;
	label?: string;
	config_id?: string | null;
	score?: number | null;
	score_pct?: string | number | null;
	paired_items?: number | null;
	is_baseline?: boolean;
	status?: string;
	status_reason?: string | null;
	overrides?: Knobs | null;
};
type TuneRound = {
	round: number;
	stage?: string | null;
	item_from?: number;
	item_to?: number;
	survivors?: number | null;
	baseline_gen_tps?: number | null;
	drift_ratio?: number | null;
	decision?: string | null;
};
type TunePause = {
	pause_id?: number;
	trigger_kind?: string | null;
	round?: number | null;
	temp_before?: number | null;
	temp_after?: number | null;
	power_before?: number | null;
	power_after?: number | null;
	drift_ratio?: number | null;
	resolution?: string | null;
};
type TuneGuard = {
	n?: number;
	b?: number;
	c?: number;
	p?: number;
	discordant?: number;
	psi?: number;
	winner_passed?: number;
	incumbent_passed?: number;
	mde?: number;
	needed?: number;
	regressed?: boolean;
};
type CurrentVisit = {
	candidate_sha?: string;
	label?: string;
	elapsed_seconds?: number;
	tokens_per_second?: number | null;
	n_gen?: number | null;
};
/** One event of /tune/log or the answer of /tune/status (tuning/tune.py's sweep_report, plus the router's fields). */
type TuneStatus = {
	error?: string;
	sweep_id?: string;
	running?: boolean;
	last_error?: string | null;
	profile?: string | null;
	tier?: string | null;
	benchmark?: string | null;
	budget_mode?: string | null;
	item_count?: number | null;
	verdict?: string | null;
	verdict_reason?: string | null;
	resumable?: boolean;
	time?: { cooling_share?: number | null; pauses?: number } | null;
	rounds?: TuneRound[];
	candidates?: TuneCandidate[];
	pauses?: TunePause[];
	not_measured?: { candidate_sha?: string; reason?: string | null }[];
	blocked?: string[];
	design_audit?: string | null;
	guard?: TuneGuard | null;
	adoption?: { overrides?: Knobs; config_id?: string | null; reduces_context?: boolean } | null;
	current_visit?: CurrentVisit | null;
};
type RecentSweep = {
	sweep_id: string;
	started_at?: number;
	profile?: string | null;
	tier?: string | null;
	verdict?: string | null;
};

type FormField = 'candidates' | 'roundItems' | 'eta' | 'seed';
const FORM_ORDER: readonly FormField[] = ['candidates', 'roundItems', 'eta', 'seed'];

/** A whole number at least `min`; empty is allowed where the field is optional. */
const wholeNumberProblem = (value: string, min: number, optional: boolean, what: string): string | undefined => {
	const v = value.trim();
	if (v === '') return optional ? undefined : `Enter ${what}, a whole number of at least ${min}.`;
	return /^\d+$/.test(v) && Number(v) >= min ? undefined : `Enter a whole number of at least ${min}.`;
};

/**
 * Ports Tune.svelte: the start-sweep form, the sweep picker and the live
 * status panel. "SSE status is a full-object re-send every ~2s; diff, don't
 * append" per Phase 5's own checklist wording (docs/history/migration-plan.md)
 * -- streamTuneLog isn't tailing a subprocess log the way Serve's stream
 * does, it's a poll-driven feed that resends the whole status object each
 * time, so each event replaces `status` wholesale, never appends to a list.
 * An event that is only `{error}` means there is no sweep to show (#919).
 *
 * The shown sweep is in the address (`?sweep=`, NAV-1); without one the page
 * follows the latest. A finished sweep leads with its outcome and the links
 * that act on it (#1055, B-D8). Design audit markdown goes through the same
 * marked + DOMPurify pipeline as ReportPage.tsx.
 */
export function TunePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();
	const sweepParam = searchParams.get('sweep');

	// -------------------------------------------------------------------
	// Start-sweep form
	// -------------------------------------------------------------------
	const [profile, setProfile] = useState(DEFAULT_OPTION);
	const [tier, setTier] = useState('smoke');
	const [benchmark, setBenchmark] = useState(DEFAULT_OPTION);
	const [system, setSystem] = useState(DEFAULT_OPTION);
	const [grid, setGrid] = useState(DEFAULT_OPTION);
	const [budget, setBudget] = useState('interactive');
	const [candidates, setCandidates] = useState('');
	const [roundItems, setRoundItems] = useState('');
	const [eta, setEta] = useState('2');
	const [seed, setSeed] = useState('0');
	const [stageRefine, setStageRefine] = useState(true);
	const [showStopConfirm, setShowStopConfirm] = useState(false);
	const [formOpen, setFormOpen] = useState<boolean | null>(null);

	const problems: Partial<Record<FormField, string>> = {
		candidates: wholeNumberProblem(candidates, 1, true, 'a number of candidates'),
		roundItems: wholeNumberProblem(roundItems, 1, true, 'a number of items'),
		eta: wholeNumberProblem(eta, 2, false, 'how many candidates a round keeps one of'),
		seed: wholeNumberProblem(seed, 0, false, 'a seed')
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
	const testOptionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const gridsQuery = useQuery({
		queryKey: ['tune-grids'],
		queryFn: () => getTuneGrids(token),
		enabled: !!token
	});
	const profileOptions: string[] = profilesQuery.data?.profiles ?? [];
	const defaultProfile = profileEntriesQuery.data?.find((e) => e.profile.is_default)?.profile.name;
	const listedTiers: string[] = testOptionsQuery.data?.tiers?.length ? testOptionsQuery.data.tiers : TIER_ORDER;
	const tierOptions = [
		...TIER_ORDER.filter((t) => listedTiers.includes(t)),
		...listedTiers.filter((t) => !TIER_ORDER.includes(t))
	];
	const benchmarkOptions: string[] = testOptionsQuery.data?.benchmarks ?? [];
	const systemOptions: string[] = testOptionsQuery.data?.systems ?? [];
	const gridOptions: string[] = gridsQuery.data?.grids ?? [];
	const effectiveProfile = profile === DEFAULT_OPTION ? defaultProfile : profile;
	const budgetInfo = BUDGETS[budget];

	const recentSweepsQuery = useQuery({
		queryKey: ['recent-sweeps'],
		queryFn: () => getRecentSweeps(token, 20),
		enabled: !!token
	});
	const recentSweeps: RecentSweep[] = recentSweepsQuery.data?.sweeps ?? [];

	// -------------------------------------------------------------------
	// Live status (SSE, full-object re-send -- see this file's own docstring)
	// -------------------------------------------------------------------
	const [status, setStatus] = useState<TuneStatus | null>(null);
	/** The server's words when there is no sweep to show (none yet, or the one asked for is gone). */
	const [missing, setMissing] = useState<string | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [follow, setFollow] = useState(0);
	const streamControllerRef = useRef<AbortController | null>(null);
	// A Start or Resume that answers after the page is gone must not open a
	// stream nothing would abort (#144).
	const unmountedRef = useRef(false);

	const showStatus = (data: TuneStatus) => {
		if (data && typeof data.error === 'string' && !data.sweep_id) {
			setStatus(null);
			setMissing(data.error);
		} else {
			setMissing(null);
			setStatus(data);
		}
	};

	const stopStreaming = () => {
		streamControllerRef.current?.abort();
		streamControllerRef.current = null;
		setStreaming(false);
	};

	const startStreaming = async (sweepId: string | null) => {
		if (unmountedRef.current) return;
		stopStreaming();
		setStatusError(null);

		// Stored before the fetch, so leaving the page or switching sweeps
		// while it is pending aborts it (#144), as ServePage does.
		const controller = new AbortController();
		streamControllerRef.current = controller;
		// A newer stream (or unmount) replaced this one: leave its state alone.
		const replaced = () => controller.signal.aborted;

		let res: Response | null;
		try {
			[res] = await streamTuneLog(token, sweepId, controller);
		} catch (err) {
			if (!replaced()) setStatusError(errorMessage(err, 'Failed to start live status stream'));
			return;
		}
		if (replaced()) return;

		if (!res?.body) {
			setStatusError('Failed to start live status stream');
			return;
		}
		// The stream opener returns any response; a refusal (401, 500) has a
		// JSON body that yields no events, and the page would go quiet (#143).
		if (!res.ok) {
			const body = await errorBody(res);
			if (!replaced()) setStatusError(errorMessage(body, 'Failed to start live status stream'));
			return;
		}

		setStreaming(true);

		try {
			for await (const evt of parseBenchmarksEventStream(res.body)) {
				if (replaced()) break;
				if (evt.event === 'done') break;
				if (evt.data) showStatus(evt.data);
			}
		} catch (err) {
			if ((err as { name?: string })?.name !== 'AbortError' && !replaced()) {
				console.error('Tune log stream error:', err);
				setStatusError(errorMessage(err, 'Live status stream ended unexpectedly'));
			}
		} finally {
			if (streamControllerRef.current === controller) {
				setStreaming(false);
				streamControllerRef.current = null;
			}
		}
	};

	const manualRefresh = async () => {
		setRefreshing(true);
		setStatusError(null);
		try {
			showStatus(await getTuneStatus(token, sweepParam));
		} catch (err) {
			const message = errorMessage(err, 'Failed to load sweep status');
			// The 404 for "no sweeps recorded" or a sweep that is gone is a state, not a failure.
			if (/^llama-tune: no sweep/.test(message)) showStatus({ error: message });
			else setStatusError(message);
		} finally {
			setRefreshing(false);
		}
	};

	/** Opening a sweep is a destination: it adds a history entry, and Back returns (NAV-1). */
	const selectSweep = (sweepId: string | null) => {
		if (sweepId === sweepParam) setFollow((n) => n + 1);
		else setSearchParams(sweepId ? { sweep: sweepId } : {});
	};

	// Follow the sweep in the address, or the latest; again whenever it changes (Back
	// included) or a Start, Resume or pick of the same sweep asks to follow it afresh.
	const startRef = useRef(startStreaming);
	startRef.current = startStreaming;
	const target = useMemo(() => ({ sweep: sweepParam, follow }), [sweepParam, follow]);
	useEffect(() => {
		void startRef.current(target.sweep);
	}, [target]);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			streamControllerRef.current?.abort();
			streamControllerRef.current = null;
		};
	}, []);

	const startMutation = useMutation({
		mutationFn: () =>
			startTune(token, {
				profile: profile === DEFAULT_OPTION ? undefined : profile,
				tier,
				benchmark: benchmark === DEFAULT_OPTION ? undefined : benchmark,
				system: system === DEFAULT_OPTION ? undefined : system,
				grid: grid === DEFAULT_OPTION ? undefined : grid,
				budget,
				candidates: candidates.trim() ? Number(candidates) : undefined,
				round_items: roundItems.trim() ? Number(roundItems) : undefined,
				eta: Number(eta),
				seed: Number(seed),
				// The server needs explore; refine descends from its winner.
				stages: stageRefine ? ['explore', 'refine'] : ['explore']
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['recent-sweeps'] });
			setFormOpen(false);
			selectSweep(null);
		}
	});

	const stopMutation = useMutation({
		mutationFn: () => stopTune(token),
		onSuccess: async () => {
			stopStreaming();
			await manualRefresh();
			await queryClient.invalidateQueries({ queryKey: ['recent-sweeps'] });
		},
		onError: (err) => setStatusError(errorMessage(err, 'Failed to stop sweep'))
	});

	const resumeMutation = useMutation({
		mutationFn: () => resumeTune(token, status?.sweep_id ?? sweepParam),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['recent-sweeps'] });
			selectSweep(sweepParam);
		}
	});

	const sortedCandidates = useMemo(
		() => [...(status?.candidates ?? [])].sort((a, b) => (b?.score ?? -Infinity) - (a?.score ?? -Infinity)),
		[status]
	);

	const designAuditHtml = useMemo(
		() => (status?.design_audit ? DOMPurify.sanitize(marked.parse(status.design_audit) as string) : null),
		[status?.design_audit]
	);

	const hasSweep = !!status?.sweep_id;
	const running = status?.running === true;
	const loaded = status !== null || missing !== null || statusError !== null;
	// The form is open while there is nothing to show, folded once a sweep is (#1114).
	const newSweepOpen = formOpen ?? (loaded && !hasSweep);
	const shownSweepId: string = sweepParam ?? status?.sweep_id ?? '';
	// A sweep that doesn't exist gets no entry: the picker shows nothing chosen, never "In progress" (NAV-3).
	const sweepChoices =
		shownSweepId && status?.sweep_id === shownSweepId && !recentSweeps.some((s) => s.sweep_id === shownSweepId)
			? [
					{ sweep_id: shownSweepId, profile: status?.profile, tier: status?.tier, verdict: status?.verdict },
					...recentSweeps
				]
			: recentSweeps;
	// The server calls only an `incomplete` sweep resumable, but resume_sweep() also takes one a dead
	// backend left without a verdict (it closes it first, and refuses one whose tuner is alive elsewhere):
	// the banner's "interrupted".
	const interrupted = hasSweep && !running && !status.verdict;
	const resumable = hasSweep && !running && (status.resumable === true || interrupted);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Tune</h2>
				<p className="text-muted-foreground text-xs">
					Run a configuration-search sweep: candidates from the profile's grid answer the same items, and the slowest
					are dropped each round until one beats the profile's own settings or none does.
				</p>
			</div>

			<Disclosure
				title="New sweep"
				description={newSweepOpen ? undefined : 'Choose a profile, tier and budget, then start a sweep.'}
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
					<div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
						<FieldBox id="tune-profile" label="Profile">
							<Select value={profile} onValueChange={setProfile}>
								<SelectTrigger id="tune-profile" className="w-full">
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
						</FieldBox>

						<FieldBox id="tune-tier" label="Tier" help="The items every candidate answers, in the same order.">
							<Select value={tier} onValueChange={setTier}>
								<SelectTrigger id="tune-tier" className="w-full" aria-describedby="tune-tier-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{tierOptions.map((t) => (
										<SelectItem key={t} value={t}>
											{t}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldBox>

						<FieldBox id="tune-benchmark" label="Benchmark">
							<Select value={benchmark} onValueChange={setBenchmark}>
								<SelectTrigger id="tune-benchmark" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_OPTION}>All benchmarks</SelectItem>
									{benchmarkOptions.map((b) => (
										<SelectItem key={b} value={b}>
											{b}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldBox>

						<FieldBox id="tune-system" label="System prompt">
							<Select value={system} onValueChange={setSystem}>
								<SelectTrigger id="tune-system" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_OPTION}>No system prompt</SelectItem>
									{systemOptions.map((s) => (
										<SelectItem key={s} value={s}>
											{s}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldBox>

						<FieldBox id="tune-grid" label="Grid" help="The knobs and values the candidates are drawn from.">
							<Select value={grid} onValueChange={setGrid}>
								<SelectTrigger id="tune-grid" className="w-full" aria-describedby="tune-grid-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_OPTION}>
										{effectiveProfile ? `The profile's (${effectiveProfile})` : "The profile's"}
									</SelectItem>
									{gridOptions.map((g) => (
										<SelectItem key={g} value={g}>
											{g}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldBox>

						<FieldBox id="tune-budget" label="Budget" help={budgetInfo?.help}>
							<Select value={budget} onValueChange={setBudget}>
								<SelectTrigger id="tune-budget" className="w-full" aria-describedby="tune-budget-help">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(BUDGETS).map(([value, b]) => (
										<SelectItem key={value} value={value}>
											{b.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldBox>
					</div>

					<div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
						<NumberBox
							id="tune-candidates"
							label="Candidates (optional)"
							value={candidates}
							onChange={setCandidates}
							placeholder={`Auto: ${budgetInfo?.candidates ?? ''}`}
							help="How many settings to try, the profile's own included."
							error={fieldErrors.errors.candidates}
							field={fieldErrors.field('candidates')}
						/>
						<NumberBox
							id="tune-round-items"
							label="First-round items (optional)"
							value={roundItems}
							onChange={setRoundItems}
							placeholder={`Auto: ${budgetInfo?.roundItems ?? ''}`}
							help="Items each candidate answers in round 1; each later round doubles it."
							error={fieldErrors.errors.roundItems}
							field={fieldErrors.field('roundItems')}
						/>
						<NumberBox
							id="tune-eta"
							label="Keep 1 in (eta)"
							value={eta}
							onChange={setEta}
							help="Each round keeps one candidate in this many; 2 halves them."
							error={fieldErrors.errors.eta}
							field={fieldErrors.field('eta')}
						/>
						<NumberBox
							id="tune-seed"
							label="Seed"
							value={seed}
							onChange={setSeed}
							help="Fixes which candidates are drawn and the item order."
							error={fieldErrors.errors.seed}
							field={fieldErrors.field('seed')}
						/>
					</div>

					<div className="flex items-start gap-2">
						<Checkbox
							id="tune-stage-refine"
							checked={stageRefine}
							onCheckedChange={(c) => setStageRefine(c === true)}
							aria-describedby="tune-stage-refine-help"
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor="tune-stage-refine">Refine the leader after exploring</Label>
							<FieldMessage
								id="tune-stage-refine-help"
								help="Exploring always runs and narrows the candidates round by round. Refining then tries the leader's neighbours on items not used yet."
							/>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<div>
							<Button type="submit" disabled={startMutation.isPending || running} aria-busy={startMutation.isPending}>
								<PlayIcon aria-hidden data-icon="inline-start" />
								{startMutation.isPending ? 'Starting…' : 'Start sweep'}
							</Button>
						</div>
						{running && <FieldMessage id="tune-start-help" help="A sweep is running. Stop it to start another." />}
						{startMutation.isError && (
							<FieldMessage id="tune-start-error" error={errorMessage(startMutation.error, 'Failed to start sweep')} />
						)}
					</div>
				</form>
			</Disclosure>

			{status?.last_error && (
				<StatusNotice tone="danger" title="The last sweep did not start" details={status.last_error}>
					<p>Check the form and the profile, then start it again.</p>
				</StatusNotice>
			)}

			{/* The sweep shown, and what can be done to it */}
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-0 grow basis-72 flex-col gap-1">
					<Label htmlFor="tune-sweep">Sweep</Label>
					<Select
						value={sweepChoices.some((s) => s.sweep_id === shownSweepId) ? shownSweepId : ''}
						disabled={sweepChoices.length === 0}
						onValueChange={(val) => {
							if (val) selectSweep(val);
						}}
					>
						<SelectTrigger id="tune-sweep" className="w-full">
							<SelectValue
								placeholder={
									recentSweepsQuery.isLoading
										? 'Loading sweeps…'
										: sweepChoices.length === 0
											? 'None recorded'
											: 'Choose a sweep'
								}
								className="truncate"
							/>
						</SelectTrigger>
						<SelectContent>
							{sweepChoices.map((sweep) => (
								<SelectItem key={sweep.sweep_id} value={sweep.sweep_id}>
									{sweepOptionLabel(sweep, running || recentSweepsQuery.data?.running === true)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={!resumable || resumeMutation.isPending}
						onClick={() => resumeMutation.mutate()}
					>
						{resumeMutation.isPending ? 'Resuming…' : 'Resume sweep'}
					</Button>

					<AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
						<AlertDialogTrigger asChild>
							<Button type="button" variant="outline" disabled={stopMutation.isPending || !running}>
								{stopMutation.isPending ? 'Stopping…' : 'Stop sweep'}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Stop sweep</AlertDialogTitle>
								<AlertDialogDescription>
									The round in progress is lost. The sweep can be resumed later from the rounds already finished.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Keep running</AlertDialogCancel>
								<AlertDialogAction onClick={() => stopMutation.mutate()}>Stop sweep</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>

					<Button type="button" variant="ghost" disabled={streaming || refreshing} onClick={manualRefresh}>
						{refreshing ? 'Refreshing…' : 'Refresh'}
					</Button>
				</div>
				{hasSweep && (
					<FieldMessage
						id="tune-sweep-actions-help"
						className="basis-full"
						help={
							running
								? 'Stop sweep loses the round in progress; the sweep can be resumed later.'
								: interrupted
									? 'Resume sweep continues this interrupted sweep.'
									: resumable
										? 'This sweep stopped before the end: Resume sweep runs the rounds left.'
										: 'Resume sweep is for a sweep that stopped before the end, and Stop sweep for one that is running.'
						}
					/>
				)}
				{resumeMutation.isError && (
					<FieldMessage
						id="tune-resume-error"
						className="basis-full"
						error={errorMessage(resumeMutation.error, 'Failed to resume sweep')}
					/>
				)}
			</div>

			{statusError && (
				<StatusNotice tone="danger" title="Couldn't follow the sweep">
					<p>{statusError}</p>
				</StatusNotice>
			)}

			{status?.current_visit && (
				<StatusNotice tone="pending" title={`Measuring ${candidateName(status.current_visit)}`}>
					<p className="tabular-nums">
						{fmtElapsed(status.current_visit.elapsed_seconds)}
						{status.current_visit.tokens_per_second
							? ` · ${fmtNum(status.current_visit.tokens_per_second, 1)} tokens/s${
									status.current_visit.n_gen ? `, ${status.current_visit.n_gen.toLocaleString()} tokens generated` : ''
								}`
							: ' · loading the model'}
					</p>
				</StatusNotice>
			)}

			{!hasSweep ? (
				loaded &&
				!statusError &&
				(sweepParam && missing ? (
					<Gone
						level={3}
						title="This sweep no longer exists"
						description={
							<>
								No sweep is called <span className="font-mono">{sweepParam}</span>. It may have been deleted, or the
								link is wrong.
							</>
						}
						actions={
							<Button variant="outline" size="sm" type="button" onClick={() => selectSweep(null)}>
								Show the latest sweep
							</Button>
						}
					/>
				) : (
					<ListEmptyState
						title="No sweeps yet"
						description="A sweep searches the profile's grid for faster serving settings. Choose a profile and tier under New sweep, then start it."
					/>
				))
			) : (
				<>
					<ResultBanner status={status} />

					<div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
						<StatTile label="Sweep" value={<span className="font-mono">{status.sweep_id}</span>} />
						<StatTile label="Profile / tier" value={`${status.profile ?? NONE} / ${status.tier ?? NONE}`} />
						<StatTile label="Benchmark" value={status.benchmark ?? 'All benchmarks'} />
						<StatTile label="Budget" value={BUDGETS[status.budget_mode ?? '']?.label ?? status.budget_mode ?? NONE} />
						<StatTile label="Items" value={status.item_count ?? NONE} />
						<StatTile label="Resumable" value={resumable ? 'Yes' : 'No'} />
						<StatTile label="Time spent cooling" value={fmtPercent(status.time?.cooling_share)} />
						<StatTile label="Pauses" value={status.time?.pauses ?? (status.pauses ?? []).length} />
					</div>

					<section className="flex flex-col gap-1">
						<h3 className="text-sm font-medium">Rounds</h3>
						<Table aria-label="Rounds" stickyHeader>
							<TableHeader>
								<TableRow>
									<TableHead className="text-right">Round</TableHead>
									<TableHead>Stage</TableHead>
									<TableHead className="text-right">Items</TableHead>
									<TableHead className="text-right">Survivors</TableHead>
									<TableHead className="text-right">Baseline generation, tokens/s</TableHead>
									<TableHead className="text-right">Drift ratio</TableHead>
									<TableHead>Decision</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(status.rounds ?? []).map((r: TuneRound) => (
									<TableRow key={r.round}>
										<TableCell className="text-muted-foreground text-right">{r.round}</TableCell>
										<TableCell>{inWords(STAGES, r.stage)}</TableCell>
										<TableCell className="text-right">
											{r.item_from}–{r.item_to}
										</TableCell>
										<TableCell className="text-right">{r.survivors ?? NONE}</TableCell>
										<TableCell className="text-right">{fmtNum(r.baseline_gen_tps, 2)}</TableCell>
										<TableCell className="text-right">{fmtNum(r.drift_ratio, 3)}</TableCell>
										<TableCell>{r.decision ?? NONE}</TableCell>
									</TableRow>
								))}
								{(status.rounds ?? []).length === 0 && (
									<TableRow>
										<TableCell colSpan={7} className="text-muted-foreground text-center">
											No rounds yet
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</section>

					<section className="flex flex-col gap-1">
						<h3 className="text-sm font-medium">Candidates</h3>
						<Table aria-label="Candidates" stickyFirstColumn stickyHeader>
							<TableHeader>
								<TableRow>
									<TableHead>Candidate</TableHead>
									<TableHead>Settings</TableHead>
									<TableHead className="text-right">Generation vs baseline</TableHead>
									<TableHead className="text-right">Paired items</TableHead>
									<TableHead>Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sortedCandidates.map((c: TuneCandidate) => {
									const live = status?.current_visit?.candidate_sha === c.candidate_sha ? status.current_visit : null;
									const state = CANDIDATE_STATUSES[c.status ?? ''];
									return (
										<TableRow key={c.candidate_sha ?? candidateName(c)}>
											<TableCell>
												<span className="font-mono">{candidateName(c)}</span>
												{c.is_baseline && (
													<Badge variant="secondary" className="ms-2">
														Baseline
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-dense">
												{c.is_baseline ? "The profile's settings" : knobsText(c.overrides) || NONE}
											</TableCell>
											<TableCell className="text-right">{c.is_baseline ? NONE : speedVsBaseline(c)}</TableCell>
											<TableCell className="text-right">{c.paired_items ?? NONE}</TableCell>
											<TableCell>
												{live ? (
													<StatusBadge label={`Measuring, ${fmtElapsed(live.elapsed_seconds)}`} tone="warning" />
												) : (
													<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
														<StatusBadge label={state?.label ?? c.status ?? NONE} tone={state?.tone ?? 'secondary'} />
														{c.status_reason && (
															<span className="text-muted-foreground text-dense">{c.status_reason}</span>
														)}
													</span>
												)}
											</TableCell>
										</TableRow>
									);
								})}
								{sortedCandidates.length === 0 && (
									<TableRow>
										<TableCell colSpan={5} className="text-muted-foreground text-center">
											No candidates yet
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</section>

					<div className="flex flex-col gap-1">
						<Disclosure
							title="Pauses"
							description="Cooling pauses taken when the machine's speed drifted."
							meta={<Badge variant="secondary">{(status.pauses ?? []).length}</Badge>}
						>
							{(status.pauses ?? []).length > 0 ? (
								<Table aria-label="Pauses">
									<TableHeader>
										<TableRow>
											<TableHead>Trigger</TableHead>
											<TableHead className="text-right">Round</TableHead>
											<TableHead className="text-right">Temperature before → after, °C</TableHead>
											<TableHead className="text-right">Power before → after, W</TableHead>
											<TableHead className="text-right">Drift ratio</TableHead>
											<TableHead>Resolution</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{(status.pauses ?? []).map((p: TunePause, idx: number) => (
											<TableRow key={p.pause_id ?? idx}>
												<TableCell>{inWords(PAUSE_TRIGGERS, p.trigger_kind)}</TableCell>
												<TableCell className="text-right">{p.round ?? NONE}</TableCell>
												<TableCell className="text-right">
													{fmtNum(p.temp_before, 1)} → {fmtNum(p.temp_after, 1)}
												</TableCell>
												<TableCell className="text-right">
													{fmtNum(p.power_before, 1)} → {fmtNum(p.power_after, 1)}
												</TableCell>
												<TableCell className="text-right">{fmtNum(p.drift_ratio, 3)}</TableCell>
												<TableCell>{inWords(PAUSE_RESOLUTIONS, p.resolution)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<p className="text-muted-foreground text-dense">No pauses.</p>
							)}
						</Disclosure>

						<Disclosure
							title="Not measured and blocked"
							description="Candidates that could not run, and comparisons the design audit ruled out."
							meta={
								<Badge variant="secondary">{(status.not_measured ?? []).length + (status.blocked ?? []).length}</Badge>
							}
						>
							<div className="grid gap-3 md:grid-cols-2">
								<div>
									<h4 className="mb-1 text-dense font-medium">Not measured</h4>
									{(status.not_measured ?? []).length > 0 ? (
										<ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-dense">
											{(status.not_measured ?? []).map((nm, i) => (
												<li key={nm.candidate_sha ?? i}>
													<span className="font-mono">{nm.candidate_sha}</span>: {nm.reason}
												</li>
											))}
										</ul>
									) : (
										<p className="text-muted-foreground text-dense">None.</p>
									)}
								</div>
								<div>
									<h4 className="mb-1 text-dense font-medium">Blocked</h4>
									{(status.blocked ?? []).length > 0 ? (
										<ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-dense">
											{(status.blocked ?? []).map((b: string, i: number) => (
												<li key={`${i}-${b}`}>{b}</li>
											))}
										</ul>
									) : (
										<p className="text-muted-foreground text-dense">None.</p>
									)}
								</div>
							</div>
						</Disclosure>

						{status.guard && (
							<Disclosure
								title="Correctness guard"
								description="Whether the winner answers as many items correctly as the profile's settings."
								meta={
									status.guard.regressed ? (
										<StatusBadge label="Regressed" tone="danger" />
									) : (
										<StatusBadge label="No regression" tone="success" />
									)
								}
							>
								<div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
									<StatTile label="Paired items" value={status.guard.n ?? NONE} />
									<StatTile label="Winner passed" value={status.guard.winner_passed ?? NONE} />
									<StatTile label="Baseline passed" value={status.guard.incumbent_passed ?? NONE} />
									<StatTile label="McNemar p" value={fmtNum(status.guard.p, 4)} />
									<StatTile label="Only the winner passed" value={status.guard.b ?? NONE} />
									<StatTile label="Only the baseline passed" value={status.guard.c ?? NONE} />
									<StatTile label="Discordant pairs" value={status.guard.discordant ?? NONE} />
									<StatTile label="Prior shift index (PSI)" value={fmtNum(status.guard.psi, 3)} />
									<StatTile label="Smallest detectable effect" value={fmtPercent(status.guard.mde)} />
									<StatTile label="Items needed" value={status.guard.needed ?? NONE} />
									<StatTile
										label="Regressed?"
										value={status.guard.regressed ? 'Yes' : 'No'}
										warn={!!status.guard.regressed}
									/>
								</div>
							</Disclosure>
						)}

						{designAuditHtml && (
							<Disclosure title="Design audit" description="What the sweep's design can and cannot conclude.">
								<div className="rich-text" dangerouslySetInnerHTML={{ __html: designAuditHtml }} />
							</Disclosure>
						)}
					</div>
				</>
			)}
		</div>
	);
}

/**
 * #1055: the sweep's outcome first. The verdict as a status, what it means,
 * the winner against the profile's own settings, and the links that act on
 * it (B-D8): the Serve form filled with the overrides it takes, the profile's
 * Edit form with every field changed, and Compare against the baseline.
 */
function ResultBanner({ status }: { status: TuneStatus }) {
	const running = status.running === true;
	// No verdict and no sweep task alive here: the backend running it stopped, so it is not in progress.
	const verdictKey: string = running ? 'running' : (status.verdict ?? 'interrupted');
	const verdict = VERDICTS[verdictKey] ?? { label: verdictKey, tone: 'secondary' as Tone };
	const winner = (status.candidates ?? []).find((c) => c.status === 'winner');
	const baseline = (status.candidates ?? []).find((c) => c.is_baseline);
	const adoption = status.adoption ?? null;
	const overrides = adoption?.overrides ?? winner?.overrides ?? null;
	const profile: string | null = status.profile ?? null;

	const headline = running
		? 'The sweep is running'
		: verdictKey === 'adopted'
			? `Adopt ${knobsText(overrides) || 'the winner'}`
			: verdictKey === 'rejected'
				? "Keep the profile's settings"
				: verdictKey === 'incomplete'
					? 'The sweep stopped before the end'
					: verdictKey === 'indeterminate'
						? 'The sweep could not decide'
						: verdictKey === 'interrupted'
							? 'The backend stopped during the sweep'
							: 'No verdict recorded';

	return (
		<section
			aria-label="Result"
			data-verdict={verdictKey}
			className="bg-surface-1 flex flex-col gap-3 rounded-lg border p-4"
		>
			<div className="flex flex-wrap items-center gap-2">
				<StatusBadge label={verdict.label} tone={verdict.tone} />
				<h3 className="text-title font-title">{headline}</h3>
				{adoption?.reduces_context && <StatusBadge label="Reduces context" tone="warning" />}
			</div>

			{(verdictKey === 'adopted' ||
				verdictKey === 'incomplete' ||
				verdictKey === 'interrupted' ||
				status.guard ||
				status.verdict_reason) && (
				<div className="text-dense flex flex-col gap-1">
					{verdictKey === 'adopted' && winner && (
						<p>
							Generation <span className="font-strong tabular-nums">{speedVsBaseline(winner)}</span> against the
							profile's settings, the median over {winner.paired_items ?? NONE} paired items.
						</p>
					)}
					{status.guard && (
						<p className="tabular-nums">
							Correctness: {status.guard.winner_passed ?? NONE} passed against the baseline's{' '}
							{status.guard.incumbent_passed ?? NONE} (McNemar p = {fmtNum(status.guard.p, 3)});{' '}
							{status.guard.regressed ? 'a regression.' : 'no regression.'}
						</p>
					)}
					{verdictKey === 'incomplete' && <p>Resume it to finish the remaining rounds.</p>}
					{verdictKey === 'interrupted' && (
						<p>
							It has no verdict, and no sweep is running in this backend. Resume sweep picks it up from the rounds
							already finished.
						</p>
					)}
					{status.verdict_reason && <p className="text-muted-foreground">{status.verdict_reason}</p>}
				</div>
			)}

			{verdictKey === 'adopted' && profile && (
				<ResultActions
					profile={profile}
					overrides={overrides}
					note={`From Tune sweep ${status.sweep_id}: ${knobsText(overrides)}`}
					compareBaseline={baseline?.config_id}
				/>
			)}
		</section>
	);
}

function FieldBox({
	id,
	label,
	help,
	children
}: {
	id: string;
	label: string;
	help?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			{children}
			<FieldMessage id={`${id}-help`} help={help} />
		</div>
	);
}

function NumberBox({
	id,
	label,
	value,
	onChange,
	placeholder,
	help,
	error,
	field
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	help: string;
	error?: string;
	field: { ref: (el: HTMLElement | null) => void; onBlur: () => void };
}) {
	const message = `${id}-message`;
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				inputMode="numeric"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				{...field}
				{...fieldProps(message, { error, help })}
			/>
			<FieldMessage id={message} error={error} help={help} />
		</div>
	);
}

function StatTile({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
	return (
		<div className={`rounded-lg p-2.5 ${warn ? 'bg-danger/10' : 'bg-muted/50'}`}>
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="truncate font-medium tabular-nums">{value}</div>
		</div>
	);
}
