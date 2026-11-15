import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Download, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TagSelector, ViewSelector } from '@/components/common/FilterSelects';
import { ListEmptyState, ListMatchCount, ListSearchBar, SortHeaderButton } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { RowButton } from '@/components/ui/row-button';
import { Textarea } from '@/components/ui/textarea';
import type { AccessGrant } from '@/lib/access/accessGrants';
import {
	createNewKnowledge,
	deleteKnowledgeById,
	exportKnowledgeById,
	searchKnowledgeBases
} from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { knowledgeMetaPreview } from './knowledgeFiles';

type KnowledgeListItem = {
	id: string;
	name: string;
	description?: string;
	updated_at: number;
	file_count?: number;
	write_access?: boolean;
	meta?: Record<string, any> | null;
	user?: { name?: string; email?: string } | null;
};
type Page = { items: KnowledgeListItem[]; total: number };

/**
 * Ports workspace/Knowledge.svelte. Unlike the Prompts/Skills lists this one
 * scrolls forever: each page is fetched when a sentinel below the list comes
 * into view (`useInfiniteQuery` + IntersectionObserver, where the Svelte page
 * hand-merges pages into an array and dedupes by id). A connected (external)
 * knowledge base shows its provider and is read-only; a document-type item
 * (`meta.document`) can't be opened.
 *
 * `showCreateOnMount` is what `/workspace/knowledge/create` sets.
 */
export function KnowledgePage({ showCreateOnMount = false }: { showCreateOnMount?: boolean }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);

	const [query, setQuery] = useState('');
	const [debouncedQuery, setDebouncedQuery] = useState('');
	const [storedView, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	// WRD-4, S4-D1: with one account there is nothing to filter by owner, and a stored view is ignored.
	const singleUser = useSingleUser();
	const viewOption = singleUser ? '' : storedView;
	const [sourceOption, setSourceOption] = useState(() => localStorage.workspaceKnowledgeSourceOption || '');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [showCreate, setShowCreate] = useState(showCreateOnMount);
	const [deleting, setDeleting] = useState<KnowledgeListItem | null>(null);
	const sentinel = useRef<HTMLDivElement>(null);
	const isAdmin = user?.role === 'admin';

	useEffect(() => {
		const t = setTimeout(() => setDebouncedQuery(query), 300);
		return () => clearTimeout(t);
	}, [query]);

	const list = useInfiniteQuery({
		queryKey: ['knowledge', debouncedQuery, viewOption, sourceOption, sortKey, sortDirection],
		initialPageParam: 1,
		queryFn: async ({ pageParam }) =>
			(await searchKnowledgeBases(
				token,
				debouncedQuery,
				viewOption,
				pageParam,
				sourceOption,
				sortKey,
				sortDirection
			)) as Page,
		// An empty page means everything has been loaded.
		getNextPageParam: (last, _all, lastParam) => ((last?.items ?? []).length === 0 ? undefined : lastParam + 1)
	});
	// Pages are fetched one after another, so a repeated id can only come from the list changing underneath us.
	const items = (() => {
		const seen = new Set<string>();
		return (list.data?.pages ?? []).flatMap((p) => p.items ?? []).filter((i) => !seen.has(i.id) && seen.add(i.id));
	})();
	const total = list.data?.pages[0]?.total ?? null;
	const failed = list.isError || (list.isPaused && list.data === undefined);

	// DAT-2, #955: the tab counts the whole list; a search or filter only narrows what is shown here.
	const filtered = debouncedQuery !== '' || viewOption !== '' || sourceOption !== '';
	const wholeCount = useWorkspaceStore((s) => s.counts.knowledge);
	useEffect(() => {
		if (total !== null && !filtered) setCount('knowledge', total);
	}, [total, filtered, setCount]);

	useEffect(() => {
		const node = sentinel.current;
		if (!node || !list.hasNextPage) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting) && !list.isFetchingNextPage) list.fetchNextPage();
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage, items.length]);

	useEffect(() => {
		setActions([{ id: 'knowledge-new', label: 'New knowledge base', onClick: () => setShowCreate(true) }]);
		return () => setActions([]);
	}, [setActions]);

	useDocumentTitle('Knowledge');

	const refetch = () => queryClient.invalidateQueries({ queryKey: ['knowledge'] });

	const deleteMutation = useMutation({
		mutationFn: (item: KnowledgeListItem) => deleteKnowledgeById(token, item.id),
		onSuccess: (res) => res && toast.success('Knowledge deleted successfully.'),
		onError: (error) => toast.error(`${error}`),
		onSettled: refetch
	});

	const exportHandler = async (item: KnowledgeListItem) => {
		try {
			const blob = await exportKnowledgeById(token, item.id);
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${item.name}.zip`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			toast.success('Knowledge exported successfully');
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const openKnowledge = (item: KnowledgeListItem) => {
		if (item.meta?.document) {
			toast.error('Only collections can be edited, create a new knowledge base to edit/add documents.');
			return;
		}
		navigate(`${routePaths.workspaceKnowledge}/${item.id}`);
	};

	const closeCreate = () => {
		setShowCreate(false);
		if (showCreateOnMount) navigate(routePaths.workspaceKnowledge);
	};

	const sortBy = (key: string) => {
		if (sortKey === key) setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setSortKey(key);
			setSortDirection(key === 'updated_at' ? 'desc' : 'asc');
		}
	};

	return (
		<div className="space-y-1">
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={`Delete “${deleting?.name ?? ''}”?`}
				confirmLabel="Delete knowledge base"
				destructive
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				{deleting?.file_count === undefined
					? 'Its files, their extracted text and embeddings are deleted.'
					: `Its ${deleting.file_count} ${deleting.file_count === 1 ? 'file' : 'files'}, their extracted text and embeddings are deleted.`}{' '}
				It can't be undone.
			</ConfirmDialog>

			<CreateKnowledgeDialog
				open={showCreate}
				onClose={closeCreate}
				onCreated={(k) => {
					setShowCreate(false);
					navigate(`${routePaths.workspaceKnowledge}/${k.id}`);
				}}
			/>

			<ListSearchBar value={query} placeholder="Search Knowledge" onChange={setQuery}>
				{!singleUser && (
					<ViewSelector
						value={viewOption}
						onChange={(value) => {
							localStorage.workspaceViewOption = value;
							setViewOption(value);
						}}
					/>
				)}
				<TagSelector
					value={sourceOption}
					placeholder="All sources"
					name="Source"
					tags={['local', 'external']}
					labels={{ local: 'Local', external: 'Connected' }}
					onChange={(value) => {
						localStorage.workspaceKnowledgeSourceOption = value;
						setSourceOption(value);
					}}
				/>
			</ListSearchBar>

			{failed ? (
				<LoadFailed what="knowledge" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
			) : list.isPending ? (
				<div className="my-16 mb-24 flex justify-center">
					<Spinner />
				</div>
			) : items.length === 0 ? (
				<ListEmptyState
					title="No knowledge bases yet"
					description="A knowledge base holds files a chat or a model can search for answers."
					action={
						<Button size="sm" type="button" onClick={() => setShowCreate(true)}>
							New knowledge base
						</Button>
					}
					query={debouncedQuery}
					filtered={viewOption !== '' || sourceOption !== ''}
					onClear={() => {
						setQuery('');
						setDebouncedQuery('');
						localStorage.workspaceViewOption = '';
						setViewOption('');
						localStorage.workspaceKnowledgeSourceOption = '';
						setSourceOption('');
					}}
				/>
			) : (
				<div className="my-1">
					{filtered && <ListMatchCount shown={total ?? items.length} total={wholeCount} noun="knowledge bases" />}
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<SortHeaderButton
							label="Title"
							active={sortKey === 'name'}
							direction={sortDirection}
							className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
							onClick={() => sortBy('name')}
						/>
						{!singleUser && <div className="hidden w-44 shrink-0 md:block" />}
						<SortHeaderButton
							label="Updated at"
							active={sortKey === 'updated_at'}
							direction={sortDirection}
							className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right"
							onClick={() => sortBy('updated_at')}
						/>
					</div>

					<div className="grid gap-y-0.5">
						{items.map((item) => {
							const preview = knowledgeMetaPreview(item);
							const external = item.meta?.source === 'external';
							return (
								// The row's controls sit beside the button that opens it, not inside it (ACT-7).
								<div
									key={item.id}
									className="group hover:bg-muted/50 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-xl px-2 py-1"
								>
									<RowButton
										className="flex min-w-0 flex-1 items-center gap-2 self-stretch hover:bg-transparent"
										onClick={() => openKnowledge(item)}
									>
										<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
											<div className="flex min-w-0 items-center gap-2 overflow-hidden">
												<Tip content={item.description ?? item.name} side="top">
													<div className="min-w-0 truncate text-dense leading-5 group-hover:underline">{item.name}</div>
												</Tip>
												{external && (
													<>
														<Badge variant="secondary">{item.meta?.external?.provider ?? 'Connected'}</Badge>
														<Badge variant="secondary">Read only</Badge>
													</>
												)}
												{!item.write_access && !external && <Badge variant="secondary">Read only</Badge>}
												<Tip content={dayjs(item.updated_at * 1000).format('LLLL')}>
													<div
														aria-hidden
														className="text-foreground-muted hidden shrink-0 text-caption leading-5 sm:block"
													>
														{dayjs(item.updated_at * 1000).fromNow()}
													</div>
												</Tip>
											</div>
											{/* LAY-4: line 2 says what it is; below sm it also carries the time. */}
											<div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-caption leading-4">
												{preview && (
													<Tip content={preview} side="top">
														<span className="text-foreground-muted min-w-0 truncate">{preview}</span>
													</Tip>
												)}
												<span aria-hidden className="text-foreground-muted ms-auto shrink-0 sm:hidden">
													{dayjs(item.updated_at * 1000).fromNow()}
												</span>
											</div>
										</div>
										{/* WRD-4: an owner says nothing with one account; it is not part of the row's name (A11Y-2). */}
										{!singleUser && (
											<div
												aria-hidden
												className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-caption leading-5 md:block"
											>
												<Tip content={item.user?.email ?? 'Deleted User'} side="top">
													<div className="truncate">
														{capitalizeFirstLetter(item.user?.name ?? item.user?.email ?? 'Deleted User')}
													</div>
												</Tip>
											</div>
										)}
									</RowButton>
									{(item.write_access || isAdmin) && (
										<div className="ml-2 flex shrink-0 flex-row items-center self-center">
											<DropdownMenu>
												<Tip content="More">
													<DropdownMenuTrigger asChild>
														<Button
															variant="ghost"
															size="icon-sm"
															type="button"
															aria-label="More Options"
															onClick={(e) => e.stopPropagation()}
														>
															<MoreHorizontal className="size-4" />
														</Button>
													</DropdownMenuTrigger>
												</Tip>
												<DropdownMenuContent align="end" className="min-w-40">
													{isAdmin && (
														<DropdownMenuItem onSelect={() => exportHandler(item)}>
															<Download />
															Export
														</DropdownMenuItem>
													)}
													<DropdownMenuSeparator />
													<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(item)}>
														<Trash2 />
														Delete
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									)}
								</div>
							);
						})}
					</div>
					{list.hasNextPage && (
						<div ref={sentinel} className="flex w-full animate-pulse items-center justify-center gap-2 py-4 text-xs">
							<Spinner className="size-4" />
							<div>Loading...</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** Ports Knowledge/CreateKnowledgeBase.svelte in its modal form (the only one the app renders). */
function CreateKnowledgeDialog({
	open,
	onClose,
	onCreated
}: {
	open: boolean;
	onClose: () => void;
	onCreated: (knowledge: { id: string }) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-lg">
				{open && <CreateForm onClose={onClose} onCreated={onCreated} />}
			</DialogContent>
		</Dialog>
	);
}

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: (k: { id: string }) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	// WRD-4, S4-D1: who may see it is a question only with several accounts.
	const singleUser = useSingleUser();
	const [name, setName] = useState('');
	const [nameError, setNameError] = useState<string | null>(null);
	const [description, setDescription] = useState('');
	const [accessGrants, setAccessGrants] = useState<AccessGrant[]>([]);
	const [loading, setLoading] = useState(false);
	const nameField = useRef<HTMLInputElement>(null);

	const submit = async () => {
		// FRM-2: an empty name is said at the field, not in a toast.
		if (name.trim() === '') {
			setNameError('Give the knowledge base a name.');
			nameField.current?.focus();
			return;
		}
		setLoading(true);
		const res = await createNewKnowledge(token, name.trim(), description.trim(), accessGrants).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) {
			toast.success('Knowledge created successfully.');
			onCreated(res);
		}
		setLoading(false);
	};

	return (
		<>
			{/* ACT-2, #1011: the dialog, its button and the Create menu say the same thing. */}
			<DialogTitle>New knowledge base</DialogTitle>
			<DialogDescription className="sr-only">Name it, and say what it is for.</DialogDescription>
			<form
				className="flex flex-col gap-4"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="knowledge-name">Name</Label>
					<Input
						id="knowledge-name"
						ref={nameField}
						value={name}
						placeholder="e.g. Statistics textbooks"
						aria-invalid={nameError ? true : undefined}
						aria-describedby={nameError ? 'knowledge-name-error' : undefined}
						onChange={(e) => {
							setName(e.target.value);
							if (e.target.value.trim()) setNameError(null);
						}}
					/>
					{nameError && (
						<p id="knowledge-name-error" className="text-dense text-danger flex items-center gap-1.5">
							<CircleAlert aria-hidden className="size-4 shrink-0" />
							{nameError}
						</p>
					)}
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="knowledge-description">Description (optional)</Label>
					<Textarea
						id="knowledge-description"
						rows={4}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What these files are, and what to use them for"
					/>
				</div>
				{!singleUser && (
					<AccessControl
						accessGrants={accessGrants}
						onChange={setAccessGrants}
						accessRoles={['read', 'write']}
						share={Boolean(user?.permissions?.sharing?.knowledge) || isAdmin}
						sharePublic={Boolean(user?.permissions?.sharing?.public_knowledge) || isAdmin}
						shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
					/>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" size="sm" disabled={loading}>
						{loading && <Spinner className="size-3.5" />}
						Create knowledge base
					</Button>
				</div>
			</form>
		</>
	);
}
