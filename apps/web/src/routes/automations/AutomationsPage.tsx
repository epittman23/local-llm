import { useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ChevronDown, Copy, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSearchBar } from '@/components/common/ListChrome';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { type AutomationResponse, createAutomation, deleteAutomationById, getAutomationItems, runAutomationById, toggleAutomationById } from '@/lib/apis/automations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { AutomationDialog } from './AutomationDialog';
import { destinationLabel, formatSchedule, parseAutomationImport, toAutomationForm } from './automationModel';
import { useDestinations } from './useDestinations';

const PER_PAGE = 30;

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

/** Ports the automations layout's header: the title (a link back from a detail page), the total, the item name, and the page's actions. */
export function AutomationsHeader({ itemName, actions }: { itemName?: string; actions?: ReactNode }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const total = useQuery({ queryKey: ['automations', 'count'], queryFn: async () => (await getAutomationItems(token, null, 'all', 1).catch(() => null))?.total ?? null });
	return (
		<div className="flex shrink-0 items-center gap-1 px-2.5 pt-2 pb-1">
			<div className="flex min-w-0 flex-1 items-center gap-1 py-1">
				{itemName ? (
					<Link to="/automations" className="hover:bg-muted rounded-lg px-1 text-sm">
						Automations
					</Link>
				) : (
					<h1 className="px-1 text-sm">Automations</h1>
				)}
				<span className="text-muted-foreground text-sm">{total.data ?? ''}</span>
				{itemName && (
					<>
						<span className="text-muted-foreground/50 px-2 text-sm">/</span>
						<h1 className="min-w-0 flex-1 truncate text-sm">{itemName}</h1>
					</>
				)}
			</div>
			{actions}
		</div>
	);
}

/**
 * Ports routes/(app)/automations/+page.svelte: search, a status filter,
 * enable/disable all, and the paged list (30 a page, from the server). Each
 * row opens the automation; its menu edits, clones, runs now or deletes; its
 * switch pauses or resumes. Create, Import JSON and Export JSON are in the header.
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
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['automations'] });
	const items = list.data?.items ?? [];

	const toggle = async (a: AutomationResponse) => {
		const res = await toggleAutomationById(token, a.id).catch((err) => void toast.error(`${err}`));
		if (res) await refresh();
	};
	const bulkToggle = async (enable: boolean) => {
		try {
			const targets = (await allAutomations(token, query || null, status)).filter((a) => a.is_active !== enable);
			await Promise.all(targets.map((a) => toggleAutomationById(token, a.id)));
			if (status !== 'all') setPage(1);
		} catch (err) {
			toast.error(`${err}`);
		}
		await refresh();
	};
	const runNow = async (a: AutomationResponse) => {
		const res = await runAutomationById(token, a.id).catch((err) => void toast.error(`${err}`));
		if (res) toast.success('Automation triggered');
	};
	const remove = async () => {
		if (!deleting) return;
		const res = await deleteAutomationById(token, deleting.id).catch((err) => void toast.error(`${err}`));
		if (res) toast.success(`Deleted ${deleting.name}`);
		setDeleting(null);
		setPage(1);
		await refresh();
	};
	const exportAll = async () => {
		try {
			const all = await allAutomations(token);
			saveAs(new Blob([JSON.stringify(all.map(toAutomationForm), null, 2)], { type: 'application/json' }), `automations-export-${Date.now()}.json`);
		} catch (err) {
			toast.error(`${err}`);
		}
	};
	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			const { forms, skipped } = parseAutomationImport(await file.text(), new Set(folders.map((f) => f.id)));
			for (const form of forms) await createAutomation(token, form);
			toast.success(skipped ? `Imported ${forms.length} automations; skipped ${skipped} incomplete` : 'Imported automations successfully');
		} catch (err) {
			toast.error(`${err}`);
		}
		setPage(1);
		await refresh();
	};

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<AutomationsHeader
				actions={
					<div className="flex items-center">
						<Button type="button" size="sm" className="rounded-r-none" onClick={() => setDialog({ cloneFrom: null })}>
							Create
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button type="button" size="sm" className="rounded-l-none border-l px-1.5" aria-label="More create options">
									<ChevronDown className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => importInput.current?.click()}>Import JSON</DropdownMenuItem>
								<DropdownMenuItem onSelect={exportAll}>Export JSON</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				}
			/>
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
				onSaved={async (id) => {
					await refresh();
					if (id) navigate(`/automations/${id}`);
				}}
			/>
			<ConfirmDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title="Delete automation?" confirmLabel="Delete" onConfirm={remove}>
				This will delete <span className="font-medium">{deleting?.name}</span>.
			</ConfirmDialog>

			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-1">
				<ListSearchBar
					value={search}
					onChange={(v) => {
						setSearch(v);
						setPage(1);
					}}
					placeholder="Search Automations"
				>
					<select
						aria-label="Status"
						className="bg-transparent px-1.5 text-[0.8125rem] outline-hidden [&>option]:bg-popover"
						value={status}
						onChange={(e) => {
							setStatus(e.target.value);
							setPage(1);
						}}
					>
						<option value="all">All</option>
						<option value="active">Active</option>
						<option value="paused">Paused</option>
					</select>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button type="button" className="text-muted-foreground hover:text-foreground flex items-center gap-0.5 px-1.5 text-[0.8125rem]">
								Actions <ChevronDown className="size-3" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => bulkToggle(true)}>Enable All</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => bulkToggle(false)}>Disable All</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</ListSearchBar>

				{list.isLoading ? (
					<div className="flex min-h-[calc(100dvh-13rem)] items-center justify-center">
						<Spinner className="size-5" />
					</div>
				) : items.length === 0 ? (
					<div className="flex min-h-[calc(100dvh-13rem)] flex-col items-center justify-center text-center">
						<div className="mb-1.5 text-sm">{query ? 'No results found' : 'No automations found'}</div>
						<div className="text-muted-foreground max-w-sm text-xs leading-5">{query ? 'Try adjusting your search or filter to find what you are looking for.' : 'Create scheduled prompts that run automatically on a recurring basis.'}</div>
					</div>
				) : (
					<ul className="my-1 grid gap-y-0.5">
						{items.map((a) => (
							<li key={a.id} className="hover:bg-muted/50 flex items-center gap-3 rounded-xl px-3 py-2 transition">
								<Link to={`/automations/${a.id}`} className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
									<span className="flex min-w-0 flex-1 items-center gap-2">
										<span className="truncate text-sm">{a.name}</span>
										<Tip content={a.last_run_at ? dayjs(a.last_run_at / 1_000_000).format('LLLL') : 'Never'}>
											<span className="text-muted-foreground shrink-0 text-xs">{a.last_run_at ? dayjs(a.last_run_at / 1_000_000).fromNow() : 'Never'}</span>
										</Tip>
									</span>
									<span className="text-muted-foreground truncate text-xs sm:max-w-[45%]">
										{formatSchedule(a.data.rrule)} · {destinationLabel(a, folders, channels)}
									</span>
								</Link>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button type="button" aria-label={`More actions for ${a.name}`} className="hover:bg-muted rounded-lg p-1">
											<MoreHorizontal className="size-4" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem onSelect={() => navigate(`/automations/${a.id}`)}>
											<Pencil /> Edit
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => setDialog({ cloneFrom: a })}>
											<Copy /> Clone
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => runNow(a)}>
											<Play /> Run now
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => setDeleting(a)}>
											<Trash2 /> Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
								<Tip content={a.is_active ? 'Enabled' : 'Disabled'}>
									<span>
										<Switch size="sm" aria-label={`${a.is_active ? 'Pause' : 'Resume'} ${a.name}`} checked={a.is_active} onCheckedChange={() => toggle(a)} />
									</span>
								</Tip>
							</li>
						))}
					</ul>
				)}
				{(list.data?.total ?? 0) > PER_PAGE && <PagePagination page={page} count={list.data?.total ?? 0} perPage={PER_PAGE} onPageChange={setPage} />}
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
