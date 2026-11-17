import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, CircleDashedIcon } from 'lucide-react';
import { Link, Outlet } from 'react-router';
import { SectionSkeleton, SectionTabs } from '@/components/layout/SectionTabs';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { checkServe, getLive, getPrescreenSweeps, getRecentSweeps } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { useBenchmarksGate } from './useBenchmarksGate';

// NAV-2: in workflow order. A pre-screen narrows the grid cheaply, Tune
// searches it, Serve/Live/Tests run one configuration, and the last three
// read the results.
const tabs = [
	{ to: routePaths.benchmarksPrescreen, label: 'Pre-screen', group: 'Configure' },
	{ to: routePaths.benchmarksTune, label: 'Tune', group: 'Configure' },
	{ to: routePaths.benchmarksServe, label: 'Serve', group: 'Run' },
	{ to: routePaths.benchmarksLive, label: 'Live', group: 'Run' },
	{ to: routePaths.benchmarksTests, label: 'Tests', group: 'Run' },
	{ to: routePaths.benchmarksCompare, label: 'Compare', group: 'Analyse' },
	{ to: routePaths.benchmarksAnswers, label: 'Answers', group: 'Analyse' },
	{ to: routePaths.benchmarksReport, label: 'Report', group: 'Analyse' }
];

/** How often the chip asks again. The pages poll their own state faster. */
const STATUS_POLL_MS = 10_000;

/**
 * Ports d863707:apps/openwebui/src/routes/(app)/benchmarks/+layout.svelte: the same
 * gate (admin + features.enable_benchmarks, see useBenchmarksGate.ts) over
 * the section's tabs, as a horizontal nav bar over an <Outlet /> instead of
 * a Svelte <slot />, plus Pre-screen (2026-10-28), which the Svelte app never
 * had. The tabs follow the workflow, in three groups, with a chip at the
 * strip's end saying what is running (#1053, B-D2).
 */
export function BenchmarksLayout() {
	const gate = useBenchmarksGate();

	if (gate !== 'allowed') return <SectionSkeleton label="benchmarks" />;

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-col gap-3 border-b px-4 pt-4">
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader title="Benchmarks" description="Serve a local model, measure it, and compare configurations." />
				</div>
				{/* On a narrow screen the chip goes above the strip, at its right, rather than squeezing it. */}
				<div className="flex flex-wrap-reverse items-center justify-end gap-x-4 gap-y-1">
					<SectionTabs label="Benchmarks" tabs={tabs} className="min-w-0 flex-[1_1_28rem]" />
					<BenchmarksStatusChip />
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-4">
				<Outlet />
			</div>
		</div>
	);
}

export type ChipState = { label: string; detail?: string; to: string };

/**
 * B-D2: what the section is doing now, linking to the page that owns it.
 * Reads the same queries the pages do (so a page's Start or Stop updates it
 * at once): a pre-screen, then a tune sweep, then a served model, then a run
 * still being recorded, else nothing. A Tests run has no status to read
 * without consuming its stream, so it shows as the model it is served on.
 */
export function BenchmarksStatusChip() {
	const token = useAuthStore((state) => state.token) ?? '';
	const options = { enabled: !!token, refetchInterval: STATUS_POLL_MS, retry: false } as const;
	const check = useQuery({ queryKey: ['serve-check'], queryFn: () => checkServe(token), ...options });
	const live = useQuery({ queryKey: ['live'], queryFn: () => getLive(token), ...options });
	const tune = useQuery({ queryKey: ['recent-sweeps'], queryFn: () => getRecentSweeps(token, 20), ...options });
	const prescreen = useQuery({
		queryKey: ['prescreen-sweeps'],
		queryFn: () => getPrescreenSweeps(token, 20),
		...options
	});

	const queries = [check, live, tune, prescreen];
	if (queries.every((q) => q.isPending)) {
		return <span aria-hidden className="bg-surface-3 mb-1 h-6 w-32 shrink-0 animate-pulse rounded-4xl" />;
	}

	const state = chipState({ check: check.data, live: live.data, tune: tune.data, prescreen: prescreen.data });
	return <StatusChip state={state} unavailable={queries.some((q) => q.isError)} />;
}

/** The chip itself (NAV-2): a success link to what is running, or a secondary word when nothing is. */
export function StatusChip({ state, unavailable = false }: { state: ChipState | null; unavailable?: boolean }) {
	return (
		<div role="status" className="flex shrink-0 items-center pb-1">
			{state ? (
				<Link to={state.to} className="inline-flex min-h-6 items-center rounded-4xl pointer-coarse:min-h-11">
					<Badge variant="success" className="text-dense h-6 px-2.5">
						<ActivityIcon aria-hidden data-icon="inline-start" />
						{state.label}
						{state.detail && (
							<>
								{' · '}
								<span className="font-mono">{state.detail}</span>
							</>
						)}
					</Badge>
				</Link>
			) : (
				<Badge variant="secondary" className="text-dense h-6 px-2.5">
					<CircleDashedIcon aria-hidden data-icon="inline-start" />
					{unavailable ? 'Status unavailable' : 'Nothing running'}
				</Badge>
			)}
		</div>
	);
}

/** The chip's words and destination, from what the four status reads answered; null when idle. */
export function chipState({
	check,
	live,
	tune,
	prescreen
}: {
	check?: { running?: boolean; profile?: string | null } | null;
	live?: { run?: { config_id?: string | null; model?: string | null } | null } | null;
	tune?: { sweeps?: { sweep_id: string; verdict?: string | null }[] } | null;
	prescreen?: { running?: boolean; active?: { sweep_id?: string } | null } | null;
}): ChipState | null {
	const sweepLink = (path: string, id?: string) => (id ? `${path}?${new URLSearchParams({ sweep: id })}` : path);
	if (prescreen?.running) {
		return { label: 'Pre-screen running', to: sweepLink(routePaths.benchmarksPrescreen, prescreen.active?.sweep_id) };
	}
	// The recent list reads an open sweep's missing verdict as 'running'.
	const latestSweep = tune?.sweeps?.[0];
	if (latestSweep?.verdict === 'running') {
		return { label: 'Tune sweep running', to: sweepLink(routePaths.benchmarksTune, latestSweep.sweep_id) };
	}
	const detail = live?.run?.config_id ? live.run.config_id.slice(0, 8) : undefined;
	if (check?.running) {
		return { label: `Serving ${check.profile ?? 'a model'}`, detail, to: routePaths.benchmarksServe };
	}
	if (live?.run) return { label: `Recording ${live.run.model ?? 'a run'}`, detail, to: routePaths.benchmarksLive };
	return null;
}
