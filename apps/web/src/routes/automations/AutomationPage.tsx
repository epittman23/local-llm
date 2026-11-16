import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronLeft, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
	type AutomationRunModel,
	deleteAutomationById,
	getAutomationById,
	getAutomationRuns,
	runAutomationById,
	toggleAutomationById
} from '@/lib/apis/automations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { dayjs } from '@/lib/utils/dates';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { AutomationDialog } from './AutomationDialog';
import {
	destinationLabel,
	formatSchedule,
	lastRun,
	localTimeZone,
	nextRunAt,
	runTarget,
	runTimeText
} from './automationModel';
import { RunBadge } from './RunBadge';
import { useAutomationResults } from './useAutomationResults';
import { useDestinations } from './useDestinations';

const RUNS_PAGE = 50;

/** DAT-5: a record's time is absolute; when it is recent the relative time follows it. */
const recordTime = (ns: number) => {
	const d = dayjs(ns / 1_000_000);
	return { exact: d.format('YYYY-MM-DD HH:mm'), relative: d.fromNow() };
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-w-0 gap-x-4 gap-y-0.5 py-1.5 sm:grid-cols-[8rem_1fr]">
			<dt className="text-foreground-muted">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

/**
 * One run (#1034, S6-D13): its status as a badge, its time, where it went,
 * and, when it failed, the whole error, wrapped, with Run again. Nothing is
 * readable only through a tooltip (A11Y-4).
 */
function RunRow({ run, onRunAgain, running }: { run: AutomationRunModel; onRunAgain: () => void; running: boolean }) {
	const when = recordTime(run.created_at);
	const failed = run.status !== 'success';
	const channel = run.chat_id?.startsWith('channel:');
	return (
		<li className="flex min-w-0 flex-col gap-1.5 border-b py-3 last:border-b-0">
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
				<RunBadge status={failed ? 'error' : 'success'} />
				<span className="tabular-nums">{when.exact}</span>
				<span className="text-foreground-muted text-dense">{when.relative}</span>
				<span className="ms-auto flex flex-wrap items-center gap-1">
					{failed && (
						<Button type="button" variant="outline" size="sm" disabled={running} onClick={onRunAgain}>
							<RotateCcw data-icon="inline-start" />
							Run again
						</Button>
					)}
					{run.chat_id && (
						<Button asChild variant="ghost" size="sm">
							<Link to={runTarget(run.chat_id)}>
								{channel ? 'Open channel' : 'Open chat'}
								<ArrowRight data-icon="inline-end" />
							</Link>
						</Button>
					)}
				</span>
			</div>
			{run.error && <p className="text-danger text-dense break-words whitespace-pre-wrap">{run.error}</p>}
		</li>
	);
}

/**
 * Ports routes/(app)/automations/[id] and components/automations/
 * AutomationEditor.svelte: the automation's status, schedule and its next
 * runs, destination, model and last run, its instructions, and its runs (50
 * at a time, more on scroll). The header pauses or resumes, runs now, edits
 * and deletes. An automation that is gone says so in place (NAV-3).
 */
function Automation() {
	const { id = '' } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { folders, channels } = useDestinations();
	const [editing, setEditing] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [running, setRunning] = useState(false);

	const automation = useQuery({
		queryKey: ['automations', 'item', id],
		queryFn: () => getAutomationById(token, id),
		retry: false
	});
	const runs = useInfiniteQuery({
		queryKey: ['automations', 'runs', id],
		queryFn: ({ pageParam }) =>
			getAutomationRuns(token, id, pageParam * RUNS_PAGE, RUNS_PAGE).then((r) => (r ?? []) as AutomationRunModel[]),
		initialPageParam: 0,
		getNextPageParam: (last, pages) => (last.length < RUNS_PAGE ? undefined : pages.length),
		enabled: automation.isSuccess
	});
	useAutomationResults(id);
	const gone = (automation.isError && isNotFound(automation.error)) || (automation.isSuccess && !automation.data);
	useDocumentTitle(gone ? 'Automation not found' : automation.data?.name || 'Automation');

	if (gone)
		return (
			<Gone
				title="This automation no longer exists"
				description="It may have been deleted."
				actions={
					<Button asChild>
						<Link to="/automations">Back to automations</Link>
					</Button>
				}
			/>
		);
	if (automation.isError)
		return (
			<div className="p-4">
				<LoadFailed
					what="this automation"
					error={automation.error}
					onRetry={() => automation.refetch()}
					retrying={automation.isFetching}
				/>
			</div>
		);
	const a = automation.data;
	if (!a) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	// Run now, a pause and an edit change the automation itself (its last run, next run), not only its runs (#915).
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['automations'] });
	const toggle = async () => {
		const res = await toggleAutomationById(token, a.id).catch((err) =>
			toastFailure(`Couldn't ${a.is_active ? 'pause' : 'resume'} the automation`, err)
		);
		if (res) queryClient.setQueryData(['automations', 'item', id], res);
		await refresh();
	};
	const runNow = async () => {
		setRunning(true);
		const res = await runAutomationById(token, a.id).catch((err) => toastFailure("Couldn't run the automation", err));
		setRunning(false);
		if (!res) return;
		toast.success(`${a.name} is running`);
		void refresh();
		// A run that fails before its reply starts is recorded at once; look
		// again shortly. One with a reply is recorded when the reply ends,
		// and useAutomationResults refetches on its automation:result.
		setTimeout(() => void refresh(), 2000);
	};
	const remove = async () => {
		const res = await deleteAutomationById(token, a.id).catch((err) =>
			toastFailure("Couldn't delete the automation", err)
		);
		if (res) {
			toast.success(`Deleted ${a.name}`);
			await refresh();
			navigate('/automations');
		}
	};
	const allRuns = runs.data?.pages.flat() ?? [];
	const last = lastRun(a);
	const next = a.is_active ? (a.next_runs?.length ? a.next_runs : [nextRunAt(a)].filter((n) => n !== null)) : [];
	const destination = destinationLabel(a, folders, channels, true);

	return (
		<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
			<div className="border-b px-4 pt-3 pb-3">
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<Button asChild variant="ghost" size="sm" className="-ms-2 mb-1">
						<Link to="/automations">
							<ChevronLeft data-icon="inline-start" />
							Automations
						</Link>
					</Button>
					{/* LAY-5: the automation's name is the h1; a long one is shortened, and whole in its tooltip. */}
					<div data-page-top="" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
						<div className="min-w-0 flex-1">
							<Tip content={a.name}>
								<h1 className="text-heading font-title truncate tracking-tight">{a.name}</h1>
							</Tip>
							<p className="text-foreground-muted mt-1">
								{formatSchedule(a.data.rrule)} · {destination}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<Tip content={a.is_active ? 'Runs on its schedule' : 'Paused'}>
								<span className="flex items-center px-1">
									<Switch aria-label="Run on its schedule" checked={a.is_active} onCheckedChange={toggle} />
								</span>
							</Tip>
							<Button type="button" variant="outline" disabled={running} onClick={runNow}>
								{running ? <Spinner className="size-3.5" /> : <Play data-icon="inline-start" />}
								Run now
							</Button>
							<Tip content="Edit">
								<Button type="button" variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(true)}>
									<Pencil />
								</Button>
							</Tip>
							<Tip content="Delete">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label="Delete"
									onClick={() => setConfirmDelete(true)}
								>
									<Trash2 />
								</Button>
							</Tip>
						</div>
					</div>
				</div>
			</div>
			<AutomationDialog open={editing} onOpenChange={setEditing} automation={a} onSaved={refresh} />
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete automation?"
				confirmLabel="Delete automation"
				destructive
				onConfirm={remove}
			>
				<span className="font-medium">{a.name}</span> and its run history are deleted. Chats its runs made are kept.
			</ConfirmDialog>

			<div
				className="min-h-0 flex-1 overflow-y-auto px-4 pb-6"
				onScroll={(e) => {
					const t = e.currentTarget;
					if (t.scrollTop + t.clientHeight >= t.scrollHeight - 50 && runs.hasNextPage && !runs.isFetchingNextPage)
						runs.fetchNextPage();
				}}
			>
				<dl className="max-w-[48rem] py-3">
					<Detail label="Status">
						{a.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Paused</Badge>}
					</Detail>
					<Detail label="Schedule">{formatSchedule(a.data.rrule)}</Detail>
					<Detail label="Next runs">
						{next.length ? (
							<>
								{next
									.slice(0, 3)
									.map((ns) => runTimeText(new Date(ns / 1_000_000)))
									.join('; ')}
								<span className="text-foreground-muted"> ({localTimeZone()})</span>
							</>
						) : a.is_active ? (
							'None: the schedule has no runs left'
						) : (
							'None while paused'
						)}
					</Detail>
					<Detail label="Posts to">{destination}</Detail>
					<Detail label="Model">
						<span className="font-mono">{a.data.model_id}</span>
					</Detail>
					<Detail label="Last run">
						{last ? (
							<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
								{last.status && <RunBadge status={last.status} />}
								<span className="tabular-nums">{recordTime(last.at).exact}</span>
								<span className="text-foreground-muted">{recordTime(last.at).relative}</span>
							</span>
						) : (
							'Never'
						)}
					</Detail>
				</dl>
				<section aria-labelledby="automation-instructions" className="max-w-[72ch] border-t py-3">
					<h2 id="automation-instructions" className="text-foreground-muted mb-2 font-strong">
						Instructions
					</h2>
					<p className="break-words whitespace-pre-wrap">{a.data.prompt}</p>
				</section>
				<section aria-labelledby="automation-runs" className="max-w-[48rem] border-t pt-3">
					<h2 id="automation-runs" className="text-foreground-muted font-strong">
						Runs
					</h2>
					{runs.isLoading ? (
						<div className="flex justify-center py-8">
							<Spinner className="size-4" />
						</div>
					) : runs.isError ? (
						<LoadFailed what="the runs" error={runs.error} onRetry={() => runs.refetch()} retrying={runs.isFetching} />
					) : allRuns.length === 0 ? (
						<p className="text-foreground-muted py-2">No runs yet. Run now starts one.</p>
					) : (
						<ul>
							{allRuns.map((run) => (
								<RunRow key={run.id} run={run} onRunAgain={runNow} running={running} />
							))}
							{runs.isFetchingNextPage && (
								<li className="flex justify-center py-4">
									<Spinner className="size-4" />
								</li>
							)}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

export function AutomationPage() {
	return (
		<FeatureGate feature="automations">
			<Automation />
		</FeatureGate>
	);
}
