import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
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
import { useAuthStore } from '@/lib/stores/authStore';

const DEFAULT_OPTION = '__default__';

const fmtNum = (n: unknown, digits = 3): string => (typeof n === 'number' ? n.toFixed(digits) : '—');

const fmtElapsed = (seconds: unknown): string => {
	if (typeof seconds !== 'number') return '—';
	const s = Math.floor(seconds);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
};

const candidateName = (c: Record<string, unknown>): string =>
	(c.label as string) || (c.config_id as string) || (c.candidate_sha as string) || '(unnamed)';

/**
 * Ports Tune.svelte: the start-sweep form, resume/recent-sweeps controls,
 * and the live status panel (summary, rounds, candidates, pauses,
 * not-measured/blocked, design audit, adoption, guard). "SSE status is a
 * full-object re-send every ~2s; diff, don't append" per Phase 5's own
 * checklist wording (docs/migration-plan.md) -- streamTuneLog isn't tailing
 * a subprocess log the way Serve's stream does, it's a poll-driven feed
 * that resends the whole status object each time, so each event just
 * replaces `status` wholesale (setStatus(data)), never appends to a list.
 * Design audit markdown goes through the same marked + DOMPurify pipeline
 * as ReportPage.tsx, for the same reason (Tune.svelte's own {@html} there
 * is unsanitized; this adds sanitization as defense in depth).
 */
export function TunePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();

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
	const [stageExplore, setStageExplore] = useState(true);
	const [stageRefine, setStageRefine] = useState(true);
	const [showStopConfirm, setShowStopConfirm] = useState(false);

	const profilesQuery = useQuery({
		queryKey: ['serve-profiles'],
		queryFn: () => getServeProfiles(token),
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
	const tierOptions: string[] = testOptionsQuery.data?.tiers?.length
		? testOptionsQuery.data.tiers
		: ['smoke', 'standard', 'full'];
	const benchmarkOptions: string[] = testOptionsQuery.data?.benchmarks ?? [];
	const systemOptions: string[] = testOptionsQuery.data?.systems ?? [];
	const gridOptions: string[] = gridsQuery.data?.grids ?? [];

	// -------------------------------------------------------------------
	// Resume / recent sweeps
	// -------------------------------------------------------------------
	const [sweepIdInput, setSweepIdInput] = useState('');
	const [viewSweepId, setViewSweepId] = useState<string | null>(null);

	const recentSweepsQuery = useQuery({
		queryKey: ['recent-sweeps'],
		queryFn: () => getRecentSweeps(token, 20),
		enabled: !!token
	});
	const recentSweeps: any[] = recentSweepsQuery.data?.sweeps ?? [];

	// -------------------------------------------------------------------
	// Live status (SSE, full-object re-send -- see this file's own docstring)
	// -------------------------------------------------------------------
	const [status, setStatus] = useState<any>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const streamControllerRef = useRef<AbortController | null>(null);

	const stopStreaming = () => {
		streamControllerRef.current?.abort();
		streamControllerRef.current = null;
		setStreaming(false);
	};

	const startStreaming = async (sweepId: string | null) => {
		stopStreaming();
		setStatusError(null);

		let res: Response | null;
		let controller: AbortController | null;
		try {
			[res, controller] = await streamTuneLog(token, sweepId);
		} catch (err: any) {
			setStatusError(err?.detail ?? 'Failed to start live status stream');
			return;
		}

		if (!res || !res.body) {
			setStatusError('Failed to start live status stream');
			return;
		}

		streamControllerRef.current = controller;
		setStreaming(true);

		try {
			for await (const evt of parseBenchmarksEventStream(res.body)) {
				if (evt.event === 'done') break;
				if (evt.data) setStatus(evt.data);
			}
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				console.error('Tune log stream error:', err);
				setStatusError(err?.detail ?? 'Live status stream ended unexpectedly');
			}
		} finally {
			setStreaming(false);
			streamControllerRef.current = null;
		}
	};

	const manualRefresh = async () => {
		setRefreshing(true);
		setStatusError(null);
		try {
			setStatus(await getTuneStatus(token, viewSweepId));
		} catch (err: any) {
			setStatusError(err?.detail ?? 'Failed to load sweep status');
		} finally {
			setRefreshing(false);
		}
	};

	const selectSweep = (sweepId: string | null) => {
		setViewSweepId(sweepId);
		setSweepIdInput(sweepId ?? '');
		startStreaming(sweepId);
	};

	// Watch whatever sweep is currently active/latest, if any, on mount.
	useEffect(() => {
		startStreaming(null);
		return stopStreaming;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const startMutation = useMutation({
		mutationFn: () => {
			const stages = [...(stageExplore ? ['explore'] : []), ...(stageRefine ? ['refine'] : [])];
			return startTune(token, {
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
				stages: stages.length > 0 ? stages : undefined
			});
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['recent-sweeps'] });
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
		onError: (err: any) => setStatusError(err?.detail ?? 'Failed to stop sweep')
	});

	const resumeMutation = useMutation({
		mutationFn: () => resumeTune(token, sweepIdInput.trim() || null),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['recent-sweeps'] });
			selectSweep(sweepIdInput.trim() || null);
		}
	});

	const sortedCandidates = useMemo(
		() =>
			[...(status?.candidates ?? [])].sort(
				(a, b) => (b?.score ?? -Infinity) - (a?.score ?? -Infinity)
			),
		[status]
	);

	const designAuditHtml = useMemo(
		() => (status?.design_audit ? DOMPurify.sanitize(marked.parse(status.design_audit) as string) : null),
		[status?.design_audit]
	);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Tune</h2>
				<p className="text-muted-foreground text-xs">
					Run a configuration-search sweep to find better serving settings.
				</p>
			</div>

			{/* Start-sweep form */}
			<form
				className="bg-muted/50 flex flex-col gap-3 rounded-lg p-3"
				onSubmit={(e) => {
					e.preventDefault();
					startMutation.mutate();
				}}
			>
				<div className="flex flex-wrap gap-3">
					<div className="flex flex-col gap-1">
						<Label>Profile</Label>
						<Select value={profile} onValueChange={setProfile}>
							<SelectTrigger className="w-40">
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
						<Label>Tier</Label>
						<Select value={tier} onValueChange={setTier}>
							<SelectTrigger className="w-32">
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
					</div>

					<div className="flex flex-col gap-1">
						<Label>Benchmark</Label>
						<Select value={benchmark} onValueChange={setBenchmark}>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
								{benchmarkOptions.map((b) => (
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
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
								{systemOptions.map((s) => (
									<SelectItem key={s} value={s}>
										{s}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<Label>Grid</Label>
						<Select value={grid} onValueChange={setGrid}>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
								{gridOptions.map((g) => (
									<SelectItem key={g} value={g}>
										{g}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1">
						<Label>Budget</Label>
						<Select value={budget} onValueChange={setBudget}>
							<SelectTrigger className="w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{['interactive', 'overnight', 'multiday', 'trials'].map((b) => (
									<SelectItem key={b} value={b}>
										{b}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<Label htmlFor="tune-candidates">Candidates</Label>
						<Input
							id="tune-candidates"
							className="w-24"
							type="number"
							min={1}
							placeholder="Auto"
							value={candidates}
							onChange={(e) => setCandidates(e.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1">
						<Label htmlFor="tune-round-items">Round items</Label>
						<Input
							id="tune-round-items"
							className="w-24"
							type="number"
							min={1}
							placeholder="Auto"
							value={roundItems}
							onChange={(e) => setRoundItems(e.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1">
						<Label htmlFor="tune-eta">Eta</Label>
						<Input
							id="tune-eta"
							className="w-20"
							type="number"
							min={1}
							value={eta}
							onChange={(e) => setEta(e.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1">
						<Label htmlFor="tune-seed">Seed</Label>
						<Input
							id="tune-seed"
							className="w-20"
							type="number"
							min={0}
							value={seed}
							onChange={(e) => setSeed(e.target.value)}
						/>
					</div>

					<div className="flex items-center gap-3 pb-1.5">
						<div className="flex items-center gap-1.5 text-sm">
							<Checkbox
								id="tune-stage-explore"
								checked={stageExplore}
								onCheckedChange={(c) => setStageExplore(c === true)}
							/>
							<Label htmlFor="tune-stage-explore">Explore</Label>
						</div>
						<div className="flex items-center gap-1.5 text-sm">
							<Checkbox
								id="tune-stage-refine"
								checked={stageRefine}
								onCheckedChange={(c) => setStageRefine(c === true)}
							/>
							<Label htmlFor="tune-stage-refine">Refine</Label>
						</div>
					</div>

					<Button type="submit" disabled={startMutation.isPending || status?.running === true}>
						{startMutation.isPending ? 'Starting…' : 'Start'}
					</Button>

					<AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
						<AlertDialogTrigger asChild>
							<Button
								type="button"
								variant="destructive"
								disabled={stopMutation.isPending || status?.running !== true}
							>
								{stopMutation.isPending ? 'Stopping…' : 'Stop'}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Stop sweep</AlertDialogTitle>
								<AlertDialogDescription>
									Are you sure you want to stop the running sweep? It can be resumed later, but
									any in-progress round is lost.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={() => stopMutation.mutate()}>Stop</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>

				{startMutation.isError && (
					<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
						{(startMutation.error as any)?.detail ?? 'Failed to start sweep'}
					</div>
				)}
				{status?.last_error && (
					<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
						Sweep failed to start: {status.last_error}
					</div>
				)}
			</form>

			{/* Resume / recent sweeps */}
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1">
					<Label htmlFor="tune-sweep-id">Sweep ID</Label>
					<Input
						id="tune-sweep-id"
						className="w-56"
						placeholder="Latest"
						value={sweepIdInput}
						onChange={(e) => setSweepIdInput(e.target.value)}
					/>
				</div>

				<Button
					type="button"
					variant="secondary"
					disabled={resumeMutation.isPending}
					onClick={() => resumeMutation.mutate()}
				>
					{resumeMutation.isPending ? 'Resuming…' : 'Resume'}
				</Button>

				<Button type="button" variant="secondary" onClick={() => selectSweep(sweepIdInput.trim() || null)}>
					View
				</Button>

				<div className="flex min-w-64 grow flex-col gap-1">
					<Label>Recent sweeps</Label>
					<Select
						value=""
						onValueChange={(val) => {
							if (val) selectSweep(val);
						}}
					>
						<SelectTrigger className="w-full">
							<SelectValue
								placeholder={recentSweepsQuery.isLoading ? 'Loading…' : 'Select a sweep'}
							/>
						</SelectTrigger>
						<SelectContent>
							{recentSweeps.map((sweep) => (
								<SelectItem key={sweep.sweep_id} value={sweep.sweep_id}>
									{sweep.sweep_id} — {sweep.profile ?? '—'} / {sweep.tier ?? '—'} ({sweep.verdict})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{resumeMutation.isError && (
					<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
						{(resumeMutation.error as any)?.detail ?? 'Failed to resume sweep'}
					</div>
				)}
			</div>

			{/* Live status panel */}
			<div className="flex items-center justify-between">
				<h3 className="flex items-center gap-2 text-sm font-medium">
					Status
					{streaming && (
						<span className="flex items-center gap-1 text-xs font-normal text-green-600 dark:text-green-400">
							<span className="size-1.5 animate-pulse rounded-full bg-green-500" />
							Live
						</span>
					)}
				</h3>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={streaming || refreshing}
					onClick={manualRefresh}
				>
					{refreshing ? 'Refreshing…' : 'Refresh'}
				</Button>
			</div>

			{status?.current_visit && (
				<div className="flex items-center gap-1.5 rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
					<span className="size-1.5 animate-pulse rounded-full bg-yellow-500" />
					Running {status.current_visit.label ?? status.current_visit.candidate_sha} —{' '}
					{fmtElapsed(status.current_visit.elapsed_seconds)}
					{status.current_visit.tokens_per_second ? (
						<>
							{' '}
							· {fmtNum(status.current_visit.tokens_per_second, 1)} tok/s
							{status.current_visit.n_gen ? ` (${status.current_visit.n_gen} tokens generated)` : ''}
						</>
					) : (
						' · loading model'
					)}
				</div>
			)}

			{statusError && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
					{statusError}
				</div>
			)}

			{!status ? (
				<p className="text-muted-foreground my-4 text-sm">No sweep status to show yet.</p>
			) : (
				<>
					<div className="grid gap-3 text-sm sm:grid-cols-2 md:grid-cols-4">
						<StatTile label="Sweep ID" value={status.sweep_id ?? '—'} />
						<StatTile label="Verdict" value={status.verdict ?? status.ended_reason ?? 'running'} />
						<StatTile label="Profile / Tier" value={`${status.profile ?? '—'} / ${status.tier ?? '—'}`} />
						<StatTile label="Budget mode" value={status.budget_mode ?? '—'} />
						<StatTile label="Benchmark" value={status.benchmark ?? '—'} />
						<StatTile label="Item count" value={status.item_count ?? '—'} />
						<StatTile label="Resumable" value={status.resumable ? 'Yes' : 'No'} />
						<StatTile label="Cooling share" value={fmtNum(status.time?.cooling_share)} />
					</div>

					{status.verdict_reason && (
						<p className="text-muted-foreground text-xs">Reason: {status.verdict_reason}</p>
					)}

					<div>
						<div className="mb-1 px-0.5 text-xs">Rounds</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>#</TableHead>
									<TableHead>Stage</TableHead>
									<TableHead className="text-right">Items</TableHead>
									<TableHead className="text-right">Survivors</TableHead>
									<TableHead className="text-right">Baseline gen tok/s</TableHead>
									<TableHead className="text-right">Drift ratio</TableHead>
									<TableHead>Decision</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(status.rounds ?? []).map((r: any) => (
									<TableRow key={r.round}>
										<TableCell className="text-muted-foreground">{r.round}</TableCell>
										<TableCell>{r.stage ?? '—'}</TableCell>
										<TableCell className="text-right">
											{r.item_from}–{r.item_to}
										</TableCell>
										<TableCell className="text-right">{r.survivors ?? '—'}</TableCell>
										<TableCell className="text-right">{fmtNum(r.baseline_gen_tps, 1)}</TableCell>
										<TableCell className="text-right">{fmtNum(r.drift_ratio)}</TableCell>
										<TableCell>{r.decision ?? '—'}</TableCell>
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
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Candidates</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Candidate</TableHead>
									<TableHead className="text-right">Score</TableHead>
									<TableHead className="text-right">Score %</TableHead>
									<TableHead className="text-right">Paired items</TableHead>
									<TableHead>Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sortedCandidates.map((c: any) => {
									const live =
										status?.current_visit?.candidate_sha === c.candidate_sha
											? status.current_visit
											: null;
									return (
										<TableRow
											key={c.candidate_sha ?? candidateName(c)}
											className={
												live
													? 'bg-yellow-500/10'
													: c.status === 'winner'
														? 'bg-green-500/10'
														: c.is_baseline
															? 'bg-blue-500/5'
															: undefined
											}
										>
											<TableCell>
												{candidateName(c)}{' '}
												{c.status === 'winner' ? (
													<span className="text-green-600 dark:text-green-400">★ winner</span>
												) : c.is_baseline ? (
													<span className="text-blue-600 dark:text-blue-400">(baseline)</span>
												) : null}
											</TableCell>
											<TableCell className="text-right">{fmtNum(c.score)}</TableCell>
											<TableCell className="text-right">{fmtNum(c.score_pct, 1)}</TableCell>
											<TableCell className="text-right">{c.paired_items ?? '—'}</TableCell>
											<TableCell>
												{live ? (
													<span className="text-yellow-700 dark:text-yellow-400">
														● running — {fmtElapsed(live.elapsed_seconds)}
														{live.tokens_per_second
															? ` · ${fmtNum(live.tokens_per_second, 1)} tok/s`
															: ' · loading'}
													</span>
												) : (
													<>
														{c.status ?? '—'}
														{c.status_reason && (
															<span className="text-muted-foreground"> — {c.status_reason}</span>
														)}
													</>
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
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Pauses ({(status.pauses ?? []).length})</div>
						{(status.pauses ?? []).length > 0 ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Trigger</TableHead>
										<TableHead className="text-right">Round</TableHead>
										<TableHead className="text-right">Temp before→after</TableHead>
										<TableHead className="text-right">Power before→after</TableHead>
										<TableHead className="text-right">Drift ratio</TableHead>
										<TableHead>Resolution</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{status.pauses.map((p: any, idx: number) => (
										<TableRow key={idx}>
											<TableCell>{p.trigger_kind ?? '—'}</TableCell>
											<TableCell className="text-right">{p.round ?? '—'}</TableCell>
											<TableCell className="text-right">
												{fmtNum(p.temp_before, 1)}→{fmtNum(p.temp_after, 1)}
											</TableCell>
											<TableCell className="text-right">
												{fmtNum(p.power_before, 1)}→{fmtNum(p.power_after, 1)}
											</TableCell>
											<TableCell className="text-right">{fmtNum(p.drift_ratio)}</TableCell>
											<TableCell>{p.resolution ?? '—'}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						) : (
							<p className="text-muted-foreground text-xs">None</p>
						)}
					</div>

					<div className="grid gap-3 md:grid-cols-2">
						<div>
							<div className="mb-1 px-0.5 text-xs">
								Not measured ({(status.not_measured ?? []).length})
							</div>
							{(status.not_measured ?? []).length > 0 ? (
								<ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
									{status.not_measured.map((nm: any, i: number) => (
										<li key={i}>
											{nm.candidate_sha}: {nm.reason}
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-xs">None</p>
							)}
						</div>

						<div>
							<div className="mb-1 px-0.5 text-xs">Blocked ({(status.blocked ?? []).length})</div>
							{(status.blocked ?? []).length > 0 ? (
								<ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
									{status.blocked.map((b: string, i: number) => (
										<li key={i}>{b}</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-xs">None</p>
							)}
						</div>
					</div>

					{designAuditHtml && (
						<div>
							<div className="mb-1 px-0.5 text-xs">Design audit</div>
							<div
								className="prose dark:prose-invert bg-muted/50 max-w-none rounded-lg p-3 text-sm"
								dangerouslySetInnerHTML={{ __html: designAuditHtml }}
							/>
						</div>
					)}

					{status.adoption && (
						<div>
							<div className="mb-1 px-0.5 text-xs">Adoption</div>
							<div className="bg-muted/50 flex flex-col gap-2 rounded-lg p-3">
								<div className="grid gap-3 text-sm sm:grid-cols-2">
									<StatTile label="Candidate SHA" value={status.adoption.candidate_sha ?? '—'} />
									<StatTile label="Config ID" value={status.adoption.config_id ?? '—'} />
								</div>
								{status.adoption.flags && (
									<code className="bg-muted w-fit rounded px-1.5 py-0.5 text-xs break-all whitespace-pre-wrap">
										{status.adoption.flags}
									</code>
								)}
								{status.adoption.reduces_context && <Badge variant="secondary">Reduces context</Badge>}
								{status.adoption.note && (
									<p className="text-muted-foreground text-xs">{status.adoption.note}</p>
								)}
							</div>
						</div>
					)}

					{status.guard && (
						<div>
							<div className="mb-1 px-0.5 text-xs">Guard</div>
							<div className="grid gap-3 text-sm sm:grid-cols-2 md:grid-cols-4">
								<StatTile label="Paired items" value={status.guard.n ?? '—'} />
								<StatTile label="Wins" value={status.guard.b ?? '—'} />
								<StatTile label="Losses" value={status.guard.c ?? '—'} />
								<StatTile label="McNemar p-value" value={fmtNum(status.guard.p, 4)} />
								<StatTile label="Discordant pairs" value={status.guard.discordant ?? '—'} />
								<StatTile label="PSI (prior shift index)" value={fmtNum(status.guard.psi)} />
								<StatTile label="Winner passed" value={status.guard.winner_passed ?? '—'} />
								<StatTile label="Incumbent passed" value={status.guard.incumbent_passed ?? '—'} />
								<StatTile label="Min. detectable effect" value={fmtNum(status.guard.mde)} />
								<StatTile label="Items needed" value={status.guard.needed ?? '—'} />
								<StatTile
									label="Regressed?"
									value={status.guard.regressed ? 'Yes' : 'No'}
									warn={!!status.guard.regressed}
								/>
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

function StatTile({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
	return (
		<div className={`rounded-lg p-2.5 ${warn ? 'bg-red-500/10' : 'bg-muted/50'}`}>
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="truncate font-medium">{value}</div>
		</div>
	);
}
