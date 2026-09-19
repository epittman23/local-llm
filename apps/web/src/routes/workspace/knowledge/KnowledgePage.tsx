import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Trash2, Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TagSelector, ViewSelector } from '@/components/common/FilterSelects';
import { ListEmptyState, ListSearchBar, SortHeaderButton, isControlClick } from '@/components/common/ListChrome';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { createNewKnowledge, deleteKnowledgeById, exportKnowledgeById, searchKnowledgeBases } from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWebUIName } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';
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
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);

	const [query, setQuery] = useState('');
	const [debouncedQuery, setDebouncedQuery] = useState('');
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
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
			(await searchKnowledgeBases(token, debouncedQuery, viewOption, pageParam, sourceOption, sortKey, sortDirection)) as Page,
		// An empty page means everything has been loaded.
		getNextPageParam: (last, _all, lastParam) => ((last?.items ?? []).length === 0 ? undefined : lastParam + 1)
	});
	// Pages are fetched one after another, so a repeated id can only come from the list changing underneath us.
	const items = (() => {
		const seen = new Set<string>();
		return (list.data?.pages ?? []).flatMap((p) => p.items ?? []).filter((i) => !seen.has(i.id) && seen.add(i.id));
	})();
	const total = list.data?.pages[0]?.total ?? null;

	useEffect(() => {
		if (total !== null) setCount('knowledge', total);
	}, [total, setCount]);

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
		setActions([{ id: 'knowledge-new', label: 'Create', onClick: () => setShowCreate(true) }]);
		return () => setActions([]);
	}, [setActions]);

	useEffect(() => {
		document.title = `Knowledge / ${webuiName}`;
	}, [webuiName]);

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
				title="Delete"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				This will delete <span className="font-normal">{deleting?.name}</span>.
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
				<ViewSelector
					value={viewOption}
					onChange={(value) => {
						localStorage.workspaceViewOption = value;
						setViewOption(value);
					}}
				/>
				<TagSelector
					value={sourceOption}
					placeholder="All Sources"
					tags={['local', 'external']}
					labels={{ local: 'Local', external: 'Connected' }}
					onChange={(value) => {
						localStorage.workspaceKnowledgeSourceOption = value;
						setSourceOption(value);
					}}
				/>
			</ListSearchBar>

			{list.isPending ? (
				<div className="my-16 mb-24 flex justify-center">
					<Spinner />
				</div>
			) : items.length === 0 ? (
				<ListEmptyState title="No knowledge found" />
			) : (
				<div className="my-1">
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<SortHeaderButton
							label="Title"
							active={sortKey === 'name'}
							direction={sortDirection}
							className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
							onClick={() => sortBy('name')}
						/>
						<div className="hidden w-44 shrink-0 md:block" />
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
								<div
									key={item.id}
									role="button"
									tabIndex={0}
									className="group hover:bg-muted/50 flex min-h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left"
									onClick={(e) => !isControlClick(e.target) && openKnowledge(item)}
									onKeyDown={(e) => {
										if (e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openKnowledge(item);
										}
									}}
								>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<Tip content={item.description ?? item.name} side="top">
												<div className="min-w-0 truncate text-[0.8125rem] leading-5 group-hover:underline">{item.name}</div>
											</Tip>
											{external && (
												<>
													<Badge variant="secondary">{item.meta?.external?.provider ?? 'Connected'}</Badge>
													<Badge variant="secondary">Read Only</Badge>
												</>
											)}
											{!item.write_access && !external && <Badge variant="secondary">Read Only</Badge>}
											<Tip content={dayjs(item.updated_at * 1000).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">
													{dayjs(item.updated_at * 1000).fromNow()}
												</div>
											</Tip>
										</div>
										{preview && (
											<Tip content={preview} side="top">
												<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">{preview}</div>
											</Tip>
										)}
									</div>
									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={item.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">{capitalizeFirstLetter(item.user?.name ?? item.user?.email ?? 'Deleted User')}</div>
										</Tip>
									</div>
									{(item.write_access || isAdmin) && (
										<div className="ml-2 flex shrink-0 flex-row items-center self-center">
											<DropdownMenu>
												<Tip content="More">
													<DropdownMenuTrigger asChild>
														<button
															type="button"
															className="text-muted-foreground flex size-6 items-center justify-center rounded-lg transition"
															aria-label="More Options"
															onClick={(e) => e.stopPropagation()}
														>
															<MoreHorizontal className="size-4" />
														</button>
													</DropdownMenuTrigger>
												</Tip>
												<DropdownMenuContent align="end" className="min-w-40">
													{isAdmin && (
														<DropdownMenuItem onSelect={() => exportHandler(item)}>
															<Download />
															Export
														</DropdownMenuItem>
													)}
													<DropdownMenuItem onSelect={() => setDeleting(item)}>
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
			<DialogContent className="sm:max-w-lg">{open && <CreateForm onClose={onClose} onCreated={onCreated} />}</DialogContent>
		</Dialog>
	);
}

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: (k: { id: string }) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [accessGrants, setAccessGrants] = useState<AccessGrant[]>([]);
	const [loading, setLoading] = useState(false);

	const submit = async () => {
		setLoading(true);
		if (name.trim() === '' || description.trim() === '') {
			toast.error('Please fill in all fields.');
			setName('');
			setDescription('');
			setLoading(false);
			return;
		}
		const res = await createNewKnowledge(token, name, description, accessGrants).catch((e) => {
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
			<DialogTitle className="text-base font-normal">Create a knowledge base</DialogTitle>
			<DialogDescription className="sr-only">Name it, describe it, and choose who can see it.</DialogDescription>
			<form
				className="flex flex-col"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="flex w-full flex-col gap-2.5">
					<div>
						<div className="text-muted-foreground mb-2 text-xs">What are you working on?</div>
						<input
							className="placeholder:text-muted-foreground/60 w-full bg-transparent text-sm outline-hidden"
							type="text"
							aria-label="Name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Name your knowledge base"
							required
						/>
					</div>
					<div>
						<div className="text-muted-foreground mb-2 text-xs">What are you trying to achieve?</div>
						<textarea
							className="placeholder:text-muted-foreground/60 w-full resize-none bg-transparent text-sm outline-hidden"
							rows={6}
							aria-label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Describe your knowledge base and objectives"
							required
						/>
					</div>
				</div>
				<div className="mt-2">
					<AccessControl
						accessGrants={accessGrants}
						onChange={setAccessGrants}
						accessRoles={['read', 'write']}
						share={Boolean(user?.permissions?.sharing?.knowledge) || isAdmin}
						sharePublic={Boolean(user?.permissions?.sharing?.public_knowledge) || isAdmin}
						shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
					/>
				</div>
				<div className="flex justify-end gap-2 pt-3">
					<Button type="button" variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" size="sm" disabled={loading}>
						Create Knowledge
						{loading && <Spinner className="size-3.5" />}
					</Button>
				</div>
			</form>
		</>
	);
}
