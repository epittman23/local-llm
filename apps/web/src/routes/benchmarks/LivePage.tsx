import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { TableSkeleton } from '@/components/common/TableSkeleton';
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
import { StatusNotice } from '@/components/ui/status-notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getLive, killLive } from '@/lib/apis/benchmarks';
import { errorMessage } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';
import { uptime } from './ServePage';

const POLL_MS = 5000;
/** The most samples a sparkline keeps: half an hour at the recorder's 5 s interval. */
const MAX_SAMPLES = 360;

type Sample = {
	sample_id?: number;
	at?: number;
	util_pct?: number | null;
	mem_used_mib?: number | null;
	mem_total_mib?: number | null;
	power_w?: number | null;
	sm_mhz?: number | null;
	temp_c?: number | null;
};
type Summary = Record<string, number | string | null | undefined>;

/** A figure with one precision and thousands separated (DAT-2); a missing one is an en dash. */
export function figure(value: unknown, digits = 0): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
	return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** llama-server's /metrics counters (telemetry_recorder.py COUNTERS) in words, with their units. */
const COUNTER_NAMES: Record<string, string> = {
	'llamacpp:prompt_tokens_total': 'Prompt tokens',
	'llamacpp:prompt_tokens_cached_total': 'Prompt tokens from the cache',
	'llamacpp:prompt_seconds_total': 'Prompt processing time, s',
	'llamacpp:tokens_predicted_total': 'Generated tokens',
	'llamacpp:tokens_predicted_seconds_total': 'Generation time, s',
	'llamacpp:spec_decode_num_draft_tokens_total': 'Draft tokens',
	'llamacpp:spec_decode_num_accepted_tokens_total': 'Accepted draft tokens',
	'llamacpp:spec_decode_num_drafts_total': 'Drafts'
};

/** Prompt and generation speed, and the share of draft tokens accepted, worked out from the counters. */
export function throughput(deltas: Record<string, number>) {
	const rate = (tokens: string, seconds: string) =>
		deltas[seconds] > 0 && deltas[tokens] !== undefined ? deltas[tokens] / deltas[seconds] : null;
	const drafted = deltas['llamacpp:spec_decode_num_draft_tokens_total'];
	const accepted = deltas['llamacpp:spec_decode_num_accepted_tokens_total'];
	return {
		prompt: rate('llamacpp:prompt_tokens_total', 'llamacpp:prompt_seconds_total'),
		generation: rate('llamacpp:tokens_predicted_total', 'llamacpp:tokens_predicted_seconds_total'),
		acceptance: drafted > 0 && accepted !== undefined ? (accepted / drafted) * 100 : null
	};
}

/**
 * The samples seen while the page is open (B-D6): each poll brings the last
 * twelve, so they are gathered here without repeats, up to MAX_SAMPLES, and
 * start again when another run is recorded.
 */
export function useSeenSamples(runId: number | null, recent: Sample[]): Sample[] {
	const [seen, setSeen] = useState<Sample[]>([]);
	const run = useRef<number | null>(null);
	useEffect(() => {
		const fresh = run.current !== runId;
		run.current = runId;
		setSeen((was) => {
			const list = fresh ? [] : was;
			const known = new Set(list.map((s) => s.sample_id ?? s.at));
			const added = recent.filter((s) => !known.has(s.sample_id ?? s.at));
			if (!fresh && added.length === 0) return was;
			return [...list, ...added].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-MAX_SAMPLES);
		});
	}, [runId, recent]);
	return seen;
}

/**
 * Ports d863707:apps/openwebui/src/lib/components/benchmarks/Live.svelte,
 * polled every 5 s. #1049: what the recorded run is and how long it has
 * run, four figures with their units and a sparkline each (VRAM with its
 * headroom, GPU utilisation while busy, power, temperature; COL-8),
 * throughput worked out from the server's counters, the spread in one
 * table, and a link to Serve beside Kill. #1050: a failed load is
 * LoadFailed in place of the page, never beside the empty state; a failed
 * refresh keeps the last figures under a notice.
 */
export function LivePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();
	const [killOpen, setKillOpen] = useState(false);

	const liveQuery = useQuery({
		queryKey: ['live'],
		queryFn: () => getLive(token),
		enabled: !!token,
		refetchInterval: POLL_MS
	});

	const killMutation = useMutation({
		mutationFn: () => killLive(token),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['live'] }),
		onError: (err) => toastFailure("Couldn't kill the server", err)
	});

	const data = liveQuery.data;
	const run = data?.run ?? null;
	const recent: Sample[] = data?.recent_samples ?? [];
	const seen = useSeenSamples(run?.run_id ?? null, recent);

	const header = (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<h2 className="text-title font-title tracking-tight">Live</h2>
			{run && (
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="outline">
						<Link to={routePaths.benchmarksServe}>Open Serve</Link>
					</Button>
					<AlertDialog open={killOpen} onOpenChange={setKillOpen}>
						<AlertDialogTrigger asChild>
							<Button
								variant="outline"
								disabled={killMutation.isPending}
								aria-busy={killMutation.isPending || undefined}
							>
								{killMutation.isPending ? 'Killing…' : 'Kill server'}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Kill the recorded server?</AlertDialogTitle>
								<AlertDialogDescription>
									This force-stops {String(run.model ?? 'the server')} at once instead of stopping it gracefully. A
									request in progress is lost, and the run is closed as killed. To stop it normally, use Stop server on
									Serve.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction variant="destructive" onClick={() => killMutation.mutate()}>
									Kill server
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}
		</div>
	);

	if (liveQuery.isLoading) {
		return (
			<div className="flex flex-col gap-6">
				{header}
				<TableSkeleton label="live telemetry" rows={4} />
			</div>
		);
	}
	if (liveQuery.isError && !data) {
		return (
			<div className="flex flex-col gap-6">
				{header}
				<LoadFailed
					what="live telemetry"
					error={liveQuery.error}
					onRetry={() => liveQuery.refetch()}
					retrying={liveQuery.isFetching}
				/>
			</div>
		);
	}
	if (!run) {
		return (
			<div className="flex flex-col gap-6">
				{header}
				<ListEmptyState
					title="Nothing is being recorded"
					description="Serve a model, and its GPU telemetry and throughput show here while it runs."
					action={
						<Button asChild>
							<Link to={routePaths.benchmarksServe}>Open Serve</Link>
						</Button>
					}
				/>
			</div>
		);
	}

	const summary: Summary = data?.summary ?? {};
	const deltas: Record<string, number> = data?.deltas ?? {};
	const speed = throughput(deltas);
	const recentRows = [...recent].reverse();
	const total = recent.find((s) => s.mem_total_mib)?.mem_total_mib ?? null;
	const throttle = typeof summary.throttle === 'string' ? summary.throttle : '';

	return (
		<div className="flex flex-col gap-6">
			{header}

			{liveQuery.isError && (
				<StatusNotice
					tone="warning"
					title="Couldn't refresh"
					details={errorMessage(liveQuery.error)}
					action={
						<Button variant="outline" size="sm" onClick={() => liveQuery.refetch()} disabled={liveQuery.isFetching}>
							{liveQuery.isFetching ? 'Trying again…' : 'Try again'}
						</Button>
					}
				>
					<p>
						These figures are from {dayjs(liveQuery.dataUpdatedAt).format('HH:mm:ss')}. The page keeps trying every 5
						seconds.
					</p>
				</StatusNotice>
			)}

			{data?.warning && (
				<StatusNotice tone="warning" title="Little VRAM to spare">
					<p>{data.warning}</p>
				</StatusNotice>
			)}

			<section aria-label="Recorded run" className="bg-surface-1 rounded-panel border p-4">
				<dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-dense sm:grid-cols-3 lg:grid-cols-6">
					<RunFact label="Model">{String(run.model ?? '–')}</RunFact>
					<RunFact label="Configuration">
						<span className="font-mono">{String(run.config_id ?? '–')}</span>
					</RunFact>
					<RunFact label="Up for">{run.started_at ? uptime(Date.now() / 1000 - run.started_at) : '–'}</RunFact>
					<RunFact label="Requests">{figure(data?.requests ?? 0)}</RunFact>
					<RunFact label="Prompt speed">{speed.prompt === null ? '–' : `${figure(speed.prompt, 1)} tokens/s`}</RunFact>
					<RunFact label="Generation speed">
						{speed.generation === null ? '–' : `${figure(speed.generation, 2)} tokens/s`}
					</RunFact>
				</dl>
			</section>

			<div className="flex flex-col gap-2">
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<Kpi
						title="VRAM used, peak"
						value={`${figure(summary.mem_max)}${total ? ` / ${figure(total)}` : ''} MiB`}
						detail={
							typeof summary.vram_headroom_mib === 'number'
								? `${figure(summary.vram_headroom_mib)} MiB to spare at the peak`
								: 'Headroom not known'
						}
						series={seen.map((s) => s.mem_used_mib)}
						max={total ?? undefined}
						seriesLabel="VRAM used"
						unit="MiB"
						tone={1}
					/>
					<Kpi
						title="GPU utilisation while busy"
						value={`${figure(summary.util_active_avg, 1)} %`}
						detail={`${figure(summary.util_avg, 1)} % over the whole run`}
						series={seen.map((s) => s.util_pct)}
						max={100}
						seriesLabel="GPU utilisation"
						unit="%"
						tone={2}
					/>
					<Kpi
						title="Power, average"
						value={`${figure(summary.power_avg, 1)} W`}
						detail={`Peak ${figure(summary.power_max, 1)} W`}
						series={seen.map((s) => s.power_w)}
						seriesLabel="Power"
						unit="W"
						tone={3}
					/>
					<Kpi
						title="Temperature, average"
						value={`${figure(summary.temp_avg, 1)} °C`}
						detail={`Peak ${figure(summary.temp_max)} °C`}
						series={seen.map((s) => s.temp_c)}
						seriesLabel="Temperature"
						unit="°C"
						tone={4}
					/>
				</div>
				<p className="text-foreground-muted text-dense">
					The lines show the {figure(seen.length)} samples seen since this page opened. Throttling:{' '}
					{throttle || 'none seen'}.
				</p>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-2">
					<h3 id="live-spread" className="font-strong">
						Spread over the run
					</h3>
					<Table aria-label="Spread over the run">
						<TableHeader>
							<TableRow>
								<TableHead scope="col">Measure</TableHead>
								<TableHead scope="col" className="text-right">
									Average
								</TableHead>
								<TableHead scope="col" className="text-right">
									Median
								</TableHead>
								<TableHead scope="col" className="text-right">
									95th percentile
								</TableHead>
								<TableHead scope="col" className="text-right">
									Peak
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<SpreadRow label="GPU utilisation, %" s={summary} k="util" digits={1} />
							<SpreadRow label="Power, W" s={summary} k="power" digits={1} />
							<SpreadRow label="SM clock, MHz" s={summary} k="sm" digits={0} />
							<SpreadRow label="VRAM used, MiB" s={summary} k="mem" digits={0} />
							<SpreadRow label="Temperature, °C" s={summary} k="temp" digits={1} />
						</TableBody>
					</Table>
					<p className="text-foreground-muted text-dense">From {figure(summary.samples)} samples.</p>
				</div>

				<div className="flex min-w-0 flex-col gap-2">
					<h3 id="live-counters" className="font-strong">
						Server counters
					</h3>
					<Table aria-label="Server counters">
						<TableHeader>
							<TableRow>
								<TableHead scope="col">Counter</TableHead>
								<TableHead scope="col" className="text-right">
									Over the run
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{Object.entries(deltas).map(([name, value]) => (
								<TableRow key={name}>
									<TableCell className="whitespace-normal">
										{COUNTER_NAMES[name] ?? <span className="font-mono">{name}</span>}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{figure(value, name.includes('seconds') ? 1 : 0)}
									</TableCell>
								</TableRow>
							))}
							{speed.acceptance !== null && (
								<TableRow>
									<TableCell>Draft tokens accepted, %</TableCell>
									<TableCell className="text-right tabular-nums">{figure(speed.acceptance, 1)}</TableCell>
								</TableRow>
							)}
							{Object.keys(deltas).length === 0 && (
								<TableRow>
									<TableCell colSpan={2} className="text-foreground-muted whitespace-normal">
										No counters yet. They appear once the server has answered a request.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
			</div>

			<div className="flex min-w-0 flex-col gap-2">
				<h3 id="live-samples" className="font-strong">
					Latest samples
				</h3>
				<Table aria-label="Latest samples">
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Time</TableHead>
							<TableHead scope="col" className="text-right">
								Utilisation, %
							</TableHead>
							<TableHead scope="col" className="text-right">
								VRAM used, MiB
							</TableHead>
							<TableHead scope="col" className="text-right">
								Power, W
							</TableHead>
							<TableHead scope="col" className="text-right">
								SM clock, MHz
							</TableHead>
							<TableHead scope="col" className="text-right">
								Temperature, °C
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{recentRows.map((sample) => (
							<TableRow key={String(sample.sample_id ?? sample.at)}>
								<TableCell className="tabular-nums">
									{sample.at ? dayjs(sample.at * 1000).format('HH:mm:ss') : '–'}
								</TableCell>
								<TableCell className="text-right tabular-nums">{figure(sample.util_pct)}</TableCell>
								<TableCell className="text-right tabular-nums">{figure(sample.mem_used_mib)}</TableCell>
								<TableCell className="text-right tabular-nums">{figure(sample.power_w, 1)}</TableCell>
								<TableCell className="text-right tabular-nums">{figure(sample.sm_mhz)}</TableCell>
								<TableCell className="text-right tabular-nums">{figure(sample.temp_c)}</TableCell>
							</TableRow>
						))}
						{recentRows.length === 0 && (
							<TableRow>
								<TableCell colSpan={6} className="text-foreground-muted whitespace-normal">
									No samples yet. The recorder takes one every 5 seconds.
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function RunFact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-foreground-muted">{label}</dt>
			<dd className="min-w-0 break-words tabular-nums">{children}</dd>
		</div>
	);
}

function SpreadRow({ label, s, k, digits }: { label: string; s: Summary; k: string; digits: number }) {
	return (
		<TableRow>
			<TableCell>{label}</TableCell>
			<TableCell className="text-right tabular-nums">{figure(s[`${k}_avg`], digits)}</TableCell>
			<TableCell className="text-right tabular-nums">{figure(s[`${k}_p50`], digits)}</TableCell>
			<TableCell className="text-right tabular-nums">{figure(s[`${k}_p95`], digits)}</TableCell>
			<TableCell className="text-right tabular-nums">{figure(s[`${k}_max`], digits)}</TableCell>
		</TableRow>
	);
}

/** A key figure with its unit (WRD-5), a line under it, and its sparkline. */
function Kpi({
	title,
	value,
	detail,
	series,
	max,
	seriesLabel,
	unit,
	tone
}: {
	title: string;
	value: string;
	detail: string;
	series: (number | null | undefined)[];
	max?: number;
	seriesLabel: string;
	unit: string;
	tone: 1 | 2 | 3 | 4;
}) {
	return (
		<section aria-label={title} className="bg-surface-1 flex min-w-0 flex-col gap-1 rounded-panel border p-3">
			<h3 className="text-foreground-muted text-dense">{title}</h3>
			<p className="text-title font-title tabular-nums">{value}</p>
			<p className="text-foreground-muted text-dense">{detail}</p>
			<Sparkline values={series} max={max} label={seriesLabel} unit={unit} tone={tone} />
		</section>
	);
}

/**
 * One series as a small line (COL-8): drawn in `--series-N` from zero, named
 * for a screen reader by what it shows and its range. Every value is also in
 * the samples table (A11Y-4).
 */
export function Sparkline({
	values,
	max,
	label,
	unit,
	tone
}: {
	values: (number | null | undefined)[];
	max?: number;
	label: string;
	unit: string;
	tone: 1 | 2 | 3 | 4;
}) {
	const points = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
	if (points.length < 2) {
		return <p className="text-foreground-muted text-caption flex h-8 items-end">Waiting for samples to draw a line.</p>;
	}
	const lo = Math.min(0, ...points);
	const hi = Math.max(max ?? 0, ...points) || 1;
	const step = 100 / (points.length - 1);
	const path = points
		.map((v, i) => `${(i * step).toFixed(2)},${(30 - ((v - lo) / (hi - lo)) * 28).toFixed(2)}`)
		.join(' ');
	const summary = `${label} over ${points.length} samples: from ${figure(Math.min(...points))} to ${figure(Math.max(...points))} ${unit}, latest ${figure(points[points.length - 1])} ${unit}`;
	return (
		<svg role="img" aria-label={summary} viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full">
			<line x1="0" x2="100" y1="31" y2="31" stroke="var(--border-divider)" vectorEffect="non-scaling-stroke" />
			<polyline
				points={path}
				fill="none"
				stroke={`var(--series-${tone})`}
				strokeWidth="1.5"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
