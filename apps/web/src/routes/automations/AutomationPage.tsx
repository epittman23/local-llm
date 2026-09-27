import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Pencil, Play, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Switch } from '@/components/ui/switch';
import { deleteAutomationById, getAutomationById, getAutomationRuns, runAutomationById, toggleAutomationById } from '@/lib/apis/automations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { AutomationDialog } from './AutomationDialog';
import { AutomationsHeader } from './AutomationsPage';
import { destinationLabel, formatSchedule, runTarget } from './automationModel';
import { useDestinations } from './useDestinations';

const RUNS_PAGE = 50;
const iconButton = 'hover:bg-muted rounded-lg p-1.5 transition disabled:opacity-50';

const formatWhen = (ns: number | null | undefined, empty: string) => {
	if (!ns) return empty;
	const d = dayjs(ns / 1_000_000);
	return d.isToday() ? `Today at ${d.format('LT')}` : d.format('L LT');
};

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex h-7 items-center px-3">
			<span className="text-muted-foreground w-24 shrink-0 text-[0.6875rem]">{label}</span>
			<span className="min-w-0 truncate text-xs">{children}</span>
		</div>
	);
}

/**
 * Ports routes/(app)/automations/[id] and components/automations/
 * AutomationEditor.svelte: the automation's status, schedule, destination,
 * model, next and last run, its prompt, and its runs (50 at a time, more on
 * scroll). The header toggles, runs now, edits and deletes. An id that does
 * not load goes back to the list.
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

	const automation = useQuery({ queryKey: ['automations', 'item', id], queryFn: () => getAutomationById(token, id), retry: false });
	const runs = useInfiniteQuery({
		queryKey: ['automations', 'runs', id],
		queryFn: ({ pageParam }) => getAutomationRuns(token, id, pageParam * RUNS_PAGE, RUNS_PAGE).then((r) => r ?? []),
		initialPageParam: 0,
		getNextPageParam: (last, pages) => (last.length < RUNS_PAGE ? undefined : pages.length),
		enabled: automation.isSuccess
	});
	useDocumentTitle(automation.data?.name || 'Automation');
	useEffect(() => {
		if (automation.isError) toast.error(`${automation.error}`);
	}, [automation.isError, automation.error]);

	if (automation.isError || (automation.isSuccess && !automation.data)) return <Navigate to="/automations" replace />;
	const a = automation.data;
	if (!a) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	const refresh = () => queryClient.invalidateQueries({ queryKey: ['automations'] });
	const toggle = async () => {
		const res = await toggleAutomationById(token, a.id).catch((err) => void toast.error(`${err}`));
		if (res) queryClient.setQueryData(['automations', 'item', id], res);
		await refresh();
	};
	const runNow = async () => {
		setRunning(true);
		const res = await runAutomationById(token, a.id).catch((err) => void toast.error(`${err}`));
		setRunning(false);
		if (res) {
			toast.success('Automation triggered');
			// The run is recorded asynchronously; look again shortly (as the original does).
			setTimeout(() => queryClient.invalidateQueries({ queryKey: ['automations', 'runs', id] }), 2000);
		}
	};
	const remove = async () => {
		const res = await deleteAutomationById(token, a.id).catch((err) => void toast.error(`${err}`));
		if (res) {
			toast.success(`Deleted ${a.name}`);
			await refresh();
			navigate('/automations');
		}
	};
	const allRuns = runs.data?.pages.flat() ?? [];

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<AutomationsHeader
				itemName={a.name}
				actions={
					<div className="flex items-center gap-0.5">
						<Tip content={a.is_active ? 'Active' : 'Paused'}>
							<span className="px-1">
								<Switch size="sm" aria-label={a.is_active ? 'Pause' : 'Resume'} checked={a.is_active} onCheckedChange={toggle} />
							</span>
						</Tip>
						<Tip content="Run now">
							<button type="button" aria-label="Run now" className={iconButton} disabled={running} onClick={runNow}>
								<Play className="size-4" />
							</button>
						</Tip>
						<Tip content="Edit">
							<button type="button" aria-label="Edit" className={iconButton} onClick={() => setEditing(true)}>
								<Pencil className="size-4" />
							</button>
						</Tip>
						<Tip content="Delete">
							<button type="button" aria-label="Delete" className={iconButton} onClick={() => setConfirmDelete(true)}>
								<Trash2 className="size-4" />
							</button>
						</Tip>
					</div>
				}
			/>
			<AutomationDialog open={editing} onOpenChange={setEditing} automation={a} onSaved={refresh} />
			<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete automation?" confirmLabel="Delete" onConfirm={remove}>
				This will delete <span className="font-medium">{a.name}</span>.
			</ConfirmDialog>

			<div
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(e) => {
					const t = e.currentTarget;
					if (t.scrollTop + t.clientHeight >= t.scrollHeight - 50 && runs.hasNextPage && !runs.isFetchingNextPage) runs.fetchNextPage();
				}}
			>
				<div className="px-1 pb-1">
					<Row label="Status">
						<span className={cn('flex items-center gap-1.5', a.is_active ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
							<span className="size-1.5 rounded-full bg-current" />
							{a.is_active ? 'Active' : 'Paused'}
						</span>
					</Row>
					<Row label="Schedule">{formatSchedule(a.data.rrule)}</Row>
					<Row label="Destination">{destinationLabel(a, folders, channels, true)}</Row>
					<Row label="Model">{a.data.model_id}</Row>
					<Row label="Next run">{formatWhen(a.next_runs?.[0] ?? a.next_run_at, 'Not scheduled')}</Row>
					<Row label="Last run">{formatWhen(a.last_run_at, 'Never')}</Row>
				</div>
				<hr className="my-1.5" />
				<div className="px-4 py-2">
					<div className="text-muted-foreground mb-2 text-[0.6875rem]">Prompt</div>
					<div className="text-sm whitespace-pre-wrap">{a.data.prompt}</div>
				</div>
				<hr className="my-1.5" />
				<div className="px-4 py-2">
					<div className="text-muted-foreground mb-1 text-[0.6875rem]">Runs</div>
					{runs.isLoading ? (
						<div className="flex justify-center py-8">
							<Spinner className="size-4" />
						</div>
					) : allRuns.length === 0 ? (
						<div className="text-muted-foreground/70 py-2 text-[0.6875rem]">No runs yet</div>
					) : (
						<ul>
							{allRuns.map((run) => (
								<li key={run.id} className="flex h-7 items-center gap-2 text-xs">
									<span className={cn('size-1.5 shrink-0 rounded-full', run.status === 'success' ? 'bg-emerald-500' : 'bg-red-400')} aria-label={run.status} />
									<span className="text-muted-foreground">{new Date(run.created_at / 1_000_000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
									{run.chat_id && (
										<Link to={runTarget(run.chat_id)} className="text-muted-foreground hover:text-foreground flex items-center gap-1 hover:underline">
											{run.chat_id.startsWith('channel:') ? 'View channel' : 'View chat'}
											<ArrowRight className="size-2.5" />
										</Link>
									)}
									{run.error && (
										<span className="truncate text-[0.6875rem] text-red-400" title={run.error}>
											{run.error}
										</span>
									)}
								</li>
							))}
							{runs.isFetchingNextPage && (
								<li className="flex justify-center py-4">
									<Spinner className="size-4" />
								</li>
							)}
						</ul>
					)}
				</div>
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
