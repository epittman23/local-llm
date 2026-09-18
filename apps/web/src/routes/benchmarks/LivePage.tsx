import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getLive, killLive } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';

const POLL_MS = 5000;

const formatValue = (value: unknown): string => {
	if (value === null || value === undefined) return '-';
	if (typeof value === 'number') return Number.isInteger(value) ? value.toString() : value.toFixed(2);
	return String(value);
};

const formatTime = (at: number | undefined): string => {
	if (at === null || at === undefined) return '-';
	try {
		return new Date(at * 1000).toLocaleTimeString();
	} catch {
		return String(at);
	}
};

/**
 * Ports apps/openwebui/src/lib/components/benchmarks/Live.svelte: the same
 * run-identity strip, summary stat grid, deltas table, and recent-samples
 * table, polled the same 5s. "polls -- refetchInterval; Kill -> AlertDialog"
 * per Phase 5's own checklist wording (docs/migration-plan.md) -- the poll
 * is TanStack Query's refetchInterval instead of Svelte's setInterval, and
 * Kill is shadcn's AlertDialog instead of the fork's own ConfirmDialog.
 */
export function LivePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();

	const liveQuery = useQuery({
		queryKey: ['live'],
		queryFn: () => getLive(token),
		enabled: !!token,
		refetchInterval: POLL_MS
	});

	const killMutation = useMutation({
		mutationFn: () => killLive(token),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['live'] })
	});

	const run = liveQuery.data?.run ?? null;
	const summary: Record<string, unknown> = liveQuery.data?.summary ?? {};
	const deltas: Record<string, unknown> = liveQuery.data?.deltas ?? {};
	const requests = liveQuery.data?.requests ?? 0;
	const recentSamples: Array<Record<string, unknown>> = [...(liveQuery.data?.recent_samples ?? [])].reverse();
	const warning = liveQuery.data?.warning ?? null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-medium">Live</h2>
				{run && (
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button variant="destructive" size="sm" disabled={killMutation.isPending}>
								{killMutation.isPending ? 'Killing…' : 'Kill'}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Kill active run</AlertDialogTitle>
								<AlertDialogDescription>
									Are you sure you want to force-kill the currently running server? This sends
									an immediate kill signal rather than a graceful stop -- any in-progress request
									is lost.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={() => killMutation.mutate()}>Kill</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				)}
			</div>

			{liveQuery.isError && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					Failed to load live status
				</div>
			)}
			{killMutation.isError && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					Failed to kill the active run
				</div>
			)}

			{liveQuery.isLoading ? (
				<div className="my-10 flex justify-center">
					<p className="text-muted-foreground text-sm">Loading…</p>
				</div>
			) : !run ? (
				<div className="text-muted-foreground rounded-lg border py-10 text-center text-sm">
					Nothing is currently being recorded
				</div>
			) : (
				<>
					{warning && (
						<div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs font-medium text-yellow-800 dark:text-yellow-200">
							⚠ {warning}
						</div>
					)}

					<div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs">
						<span>
							<span className="text-muted-foreground/70">Model:</span>{' '}
							<span className="text-foreground">{String(run.model ?? '-')}</span>
						</span>
						<span>
							<span className="text-muted-foreground/70">Config:</span>{' '}
							<span className="text-foreground">{String(run.config_id ?? '-')}</span>
						</span>
						<span>
							<span className="text-muted-foreground/70">Port:</span>{' '}
							<span className="text-foreground">{String(run.port ?? '-')}</span>
						</span>
						<span>
							<span className="text-muted-foreground/70">Requests:</span>{' '}
							<span className="text-foreground">{requests}</span>
						</span>
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Summary</div>
						<div
							className="grid gap-2"
							style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(9.5rem, 1fr))' }}
						>
							{Object.entries(summary).map(([key, value]) => (
								<div key={key} className="flex flex-col gap-0.5 rounded-lg border px-2.5 py-2">
									<span className="text-muted-foreground truncate text-[0.6875rem]">{key}</span>
									<span className="text-sm">{formatValue(value)}</span>
								</div>
							))}
							{Object.keys(summary).length === 0 && (
								<div className="text-muted-foreground text-xs">No data</div>
							)}
						</div>
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Deltas</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Counter</TableHead>
									<TableHead className="text-right">Value</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{Object.entries(deltas).map(([name, value]) => (
									<TableRow key={name}>
										<TableCell>{name}</TableCell>
										<TableCell className="text-right">{formatValue(value)}</TableCell>
									</TableRow>
								))}
								{Object.keys(deltas).length === 0 && (
									<TableRow>
										<TableCell colSpan={2} className="text-muted-foreground text-center">
											No data
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>

					<div>
						<div className="mb-1 px-0.5 text-xs">Recent Samples</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Time</TableHead>
									<TableHead className="text-right">Util %</TableHead>
									<TableHead className="text-right">Mem</TableHead>
									<TableHead className="text-right">Power (W)</TableHead>
									<TableHead className="text-right">SM MHz</TableHead>
									<TableHead className="text-right">Temp (°C)</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{recentSamples.map((sample, i) => (
									<TableRow key={String(sample.sample_id ?? sample.at ?? i)}>
										<TableCell>{formatTime(sample.at as number)}</TableCell>
										<TableCell className="text-right">{formatValue(sample.util_pct)}</TableCell>
										<TableCell className="text-right">
											{formatValue(sample.mem_used_mib)} / {formatValue(sample.mem_total_mib)}
										</TableCell>
										<TableCell className="text-right">{formatValue(sample.power_w)}</TableCell>
										<TableCell className="text-right">{formatValue(sample.sm_mhz)}</TableCell>
										<TableCell className="text-right">{formatValue(sample.temp_c)}</TableCell>
									</TableRow>
								))}
								{recentSamples.length === 0 && (
									<TableRow>
										<TableCell colSpan={6} className="text-muted-foreground text-center">
											No data
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</>
			)}
		</div>
	);
}
