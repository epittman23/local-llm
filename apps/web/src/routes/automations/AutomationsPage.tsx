import { useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ChevronDown, Copy, FileDown, FileUp, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterMenu } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListMatchCount, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import {
	type AutomationResponse,
	createAutomation,
	deleteAutomationById,
	getAutomationItems,
	runAutomationById,
	toggleAutomationById
} from '@/lib/apis/automations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { AutomationDialog } from './AutomationDialog';
import {
	destinationLabel,
	formatSchedule,
	importAutomationForms,
	importMessage,
	lastRun,
	parseAutomationImport,
	toAutomationForm
} from './automationModel';
import { RunBadge } from './RunBadge';
import { useDestinations } from './useDestinations';

const PER_PAGE = 30;

const STATUSES = [
	{ value: 'all', label: 'All' },
	{ value: 'active', label: 'Active' },
	{ value: 'paused', label: 'Paused' }
];

/** Every automation matching a filter, page by page (bulk toggle and export need them all). */
async function allAutomations(token: string, query: string | null = null, status = 'all') {
	const all: AutomationResponse[] = [];
	for (let page = 1; ; page++) {
		const res = await getAutomationItems(token, query, status, page);
		const items = res?.items ?? [];
		all.push(...items);
		if (items.length === 0 || all.length >= (res?.total ?? all.length)) return all;
	}
}

/** The page's own header (LAY-5): the h1, what the page is for, New automation, and import and export. */
function Header({ onNew, onImport, onExport }: { onNew: () => void; onImport: () => void; onExport: () => void }) {
	return (
		<div className="border-b px-4 pt-4 pb-3">
			<div className="ps-[var(--shell-menu-inset,0px)]">
				<PageHeader
					title="Automations"
					description="Instructions a model runs on a schedule, posting each answer to a chat or a channel."
					action={
						<div className="flex items-center gap-1">
							<Button type="button" onClick={onNew}>
								<Plus data-icon="inline-start" />
								New automation
							</Button>
							<DropdownMenu>
								<Tip content="Import and export">
									<DropdownMenuTrigger asChild>
										<Button type="button" variant="ghost" size="icon" aria-label="Import and export">
											<MoreHorizontal />
										</Button>
									</DropdownMenuTrigger>
								</Tip>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onSelect={onImport}>
										<FileUp /> Import from a file
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={onExport}>
										<FileDown /> Export all to a file
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					}
				/>
			</div>
		</div>
	);
}

/** One automation: its name, state and last run on the first line, its schedule and destination on the second. */
function AutomationRow({
	a,
	destination,
	onOpen,
	onClone,
	onRun,
	onDelete,
	onToggle
}: {
	a: AutomationResponse;
	destination: string;
	onOpen: () => void;
	onClone: () => void;
	onRun: () => void;
	onDelete: () => void;
	onToggle: () => void;
}) {
	const last = lastRun(a);
	const when = last ? dayjs(last.at / 1_000_000) : null;
	return (
		// LAY-4, #964: min-w-0 lets the name and schedule shorten, so the menu and switch stay on screen.
		<li className="group flex min-w-0 items-center gap-1 rounded-lg pe-1 hover:bg-surface-3">
			<RowButton className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 hover:bg-transparent" onClick={onOpen}>
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate font-strong">{a.name}</span>
					{!a.is_active && <Badge variant="secondary">Paused</Badge>}
					{last?.status && <RunBadge status={last.status} />}
					{last?.error && <span className="sr-only">: {last.error}</span>}
					{when && (
						<Tip content={`Last run ${when.format('YYYY-MM-DD HH:mm')}`}>
							<span aria-hidden className="text-foreground-muted shrink-0 text-caption whitespace-nowrap">
								{when.fromNow()}
							</span>
						</Tip>
					)}
					{!last && <span className="text-foreground-muted shrink-0 text-caption whitespace-nowrap">Never run</span>}
				</span>
				<span className="text-foreground-muted truncate text-dense">
					{formatSchedule(a.data.rrule)} · {destination}
				</span>
				{/* A11Y-4: a failure's text is on the row, not only in a tooltip. */}
				{last?.error && (
					<span aria-hidden className="text-danger line-clamp-2 text-dense break-words">
						{last.error}
					</span>
				)}
			</RowButton>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" variant="ghost" size="icon-sm" aria-label={`More actions for ${a.name}`}>
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={onOpen}>
						<Pencil /> Open
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onClone}>
						<Copy /> Duplicate
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onRun}>
						<Play /> Run now
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onSelect={onDelete}>
						<Trash2 /> Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Tip content={a.is_active ? 'Runs on its schedule' : 'Paused'}>
				<span className="flex">
					<Switch
						size="sm"
						aria-label={`Run ${a.name} on its schedule`}
						checked={a.is_active}
						onCheckedChange={onToggle}
					/>
				</span>
			</Tip>
		</li>
	);
}

/**
 * Ports routes/(app)/automations/+page.svelte: search, a status filter,
 * resume or pause all, and the paged list (30 a page, from the server). Each
 * row opens the automation and shows how its last run went (#915); its menu
 * duplicates, runs now or deletes; its switch pauses or resumes. New
 * automation, import and export are in the header (LAY-5).
 */
function Automations() {
	useDocumentTitle('Automations');
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const importInput = useRef<HTMLInputElement>(null);
	const { folders, channels } = useDestinations();
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState('all');
	const [page, setPage] = useState(1);
	const [dialog, setDialog] = useState<{ cloneFrom: AutomationResponse | null } | null>(null);
	const [deleting, setDeleting] = useState<AutomationResponse | null>(null);
	const query = useDebouncedValue(search, 300);

	const list = useQuery({
		queryKey: ['automations', 'list', query, status, page],
		queryFn: () => getAutomationItems(token, query || null, status, page),
		placeholderData: (prev) => prev
	});
	const total = useQuery({
		queryKey: ['automations', 'count'],
		queryFn: async () => (await getAutomationItems(token, null, 'all', 1).catch(() => null))?.total ?? null
	});
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['automations'] });
	const items = list.data?.items ?? [];
	// A list that did not load is a failure, not an empty list (STA-4).
	const failed = list.isError || (list.isPaused && list.data === undefined);
	const narrowed = query.trim() !== '' || status !== 'all';
	const clearFilters = () => {
		setSearch('');
		setStatus('all');
		setPage(1);
	};

	const toggle = async (a: AutomationResponse) => {
		const res = await toggleAutomationById(token, a.id).catch((err) =>
			toastFailure(`Couldn't ${a.is_active ? 'pause' : 'resume'} ${a.name}`, err)
		);
		if (res) await refresh();
	};
	const bulkToggle = async (enable: boolean) => {
		try {
			const targets = (await allAutomations(token, query || null, status)).filter((a) => a.is_active !== enable);
			await Promise.all(targets.map((a) => toggleAutomationById(token, a.id)));
			toast.success(
				`${targets.length} ${targets.length === 1 ? 'automation' : 'automations'} ${enable ? 'resumed' : 'paused'}`
			);
			if (status !== 'all') setPage(1);
		} catch (err) {
			toastFailure(`Couldn't ${enable ? 'resume' : 'pause'} every automation`, err);
		}
		await refresh();
	};
	const runNow = async (a: AutomationResponse) => {
		const res = await runAutomationById(token, a.id).catch((err) => toastFailure(`Couldn't run ${a.name}`, err));
		if (!res) return;
		toast.success(`${a.name} is running`);
		// The run is recorded once its reply ends; look again shortly (#915).
		void refresh();
		setTimeout(() => void refresh(), 2000);
	};
	const remove = async () => {
		if (!deleting) return;
		const res = await deleteAutomationById(token, deleting.id).catch((err) =>
			toastFailure(`Couldn't delete ${deleting.name}`, err)
		);
		if (res) toast.success(`Deleted ${deleting.name}`);
		setDeleting(null);
		setPage(1);
		await refresh();
	};
	const exportAll = async () => {
		try {
			const all = await allAutomations(token);
			saveAs(
				new Blob([JSON.stringify(all.map(toAutomationForm), null, 2)], { type: 'application/json' }),
				`automations-export-${Date.now()}.json`
			);
		} catch (err) {
			toastFailure("Couldn't export the automations", err);
		}
	};
	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			const { forms, skipped } = parseAutomationImport(await file.text(), new Set(folders.map((f) => f.id)));
			const { ok, message } = importMessage(
				await importAutomationForms(forms, skipped, (form) => createAutomation(token, form))
			);
			if (ok) toast.success(message);
			else toast.error(message);
		} catch (err) {
			toastFailure("Couldn't read that file as automations", err);
		}
		setPage(1);
		await refresh();
	};
	const newAutomation = () => setDialog({ cloneFrom: null });
	const statusLabel = STATUSES.find((s) => s.value === status)?.label ?? 'All';

	return (
		<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
			<Header onNew={newAutomation} onImport={() => importInput.current?.click()} onExport={exportAll} />
			<input
				ref={importInput}
				type="file"
				accept=".json"
				hidden
				aria-label="Import automations file"
				onChange={(e) => {
					importFile(e.target.files?.[0]);
					e.target.value = '';
				}}
			/>
			<AutomationDialog
				open={dialog !== null}
				onOpenChange={(o) => !o && setDialog(null)}
				cloneFrom={dialog?.cloneFrom ?? null}
				onSaved={(id) => {
					// Open the new automation at once; the list refreshes behind it.
					void refresh();
					if (id) navigate(`/automations/${id}`);
				}}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete automation?"
				confirmLabel="Delete automation"
				destructive
				onConfirm={remove}
			>
				<span className="font-medium">{deleting?.name}</span> and its run history are deleted. Chats its runs made are
				kept.
			</ConfirmDialog>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-3 pb-2">
				<ListSearchBar
					value={search}
					onChange={(v) => {
						setSearch(v);
						setPage(1);
					}}
					placeholder="Search automations"
				>
					<FilterMenu
						value={status}
						items={STATUSES}
						onChange={(v) => {
							setStatus(v);
							setPage(1);
						}}
						trigger={
							<Button type="button" variant="ghost" size="sm" aria-label={`Status: ${statusLabel}`}>
								Status: {statusLabel}
								<ChevronDown />
							</Button>
						}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="sm">
								Actions <ChevronDown />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => bulkToggle(true)}>Resume all</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => bulkToggle(false)}>Pause all</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</ListSearchBar>
				{narrowed && list.data && (
					<ListMatchCount shown={list.data.total} total={total.data ?? null} noun="automations" />
				)}

				{failed ? (
					<LoadFailed what="automations" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
				) : list.isLoading ? (
					<div className="flex flex-1 items-center justify-center py-16">
						<Spinner className="size-5" />
					</div>
				) : items.length === 0 ? (
					<ListEmptyState
						title="No automations yet"
						description="An automation runs your instructions on a schedule, such as a reading list every weekday morning."
						action={
							<Button type="button" onClick={newAutomation}>
								<Plus data-icon="inline-start" />
								New automation
							</Button>
						}
						query={query}
						filtered={status !== 'all'}
						onClear={clearFilters}
					/>
				) : (
					<ul className="grid min-w-0 gap-0.5" aria-label="Automations">
						{items.map((a) => (
							<AutomationRow
								key={a.id}
								a={a}
								destination={destinationLabel(a, folders, channels)}
								onOpen={() => navigate(`/automations/${a.id}`)}
								onClone={() => setDialog({ cloneFrom: a })}
								onRun={() => runNow(a)}
								onDelete={() => setDeleting(a)}
								onToggle={() => toggle(a)}
							/>
						))}
					</ul>
				)}
				{(list.data?.total ?? 0) > PER_PAGE && (
					<PagePagination page={page} count={list.data?.total ?? 0} perPage={PER_PAGE} onPageChange={setPage} />
				)}
			</div>
		</div>
	);
}

export function AutomationsPage() {
	return (
		<FeatureGate feature="automations">
			<Automations />
		</FeatureGate>
	);
}
