import { useQueryClient } from '@tanstack/react-query';
import {
	CheckCheck,
	ChevronDown,
	ChevronRight,
	Folder as FolderIcon,
	FolderPlus,
	MoreHorizontal,
	Pencil,
	Plus,
	Trash2
} from 'lucide-react';
import { useState } from 'react';
import { NavLink } from 'react-router';
import { toast } from 'sonner';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { canUseFeature } from '@/lib/access/features';
import {
	createNewFolder,
	deleteFolderById,
	markFolderChatsReadById,
	updateFolderById,
	updateFolderIsExpandedById
} from '@/lib/apis/folders';
import { type Folder, type FolderNode, folderTree, groupByTimeRange } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { DeleteFolderDialog, FolderDialog } from './ChatDialogs';
import { ChatItem, rowClass, rowMenuButtonClass } from './ChatItem';
import { useChatPages, useFolderChats, useFolders, usePinnedChats } from './useChatList';

/** A show/hide toggle is not a menu trigger: open, it keeps the ghost button's resting look. */
export const DISCLOSURE = 'aria-expanded:bg-transparent aria-expanded:hover:bg-muted';
const sectionHeader = 'text-foreground-muted text-caption font-strong flex w-full items-center gap-1 px-2 py-1';

/** A part of the sidebar that failed to load, said where it would be, with Try again (STA-4). */
function InlineFailed({ what, onRetry, retrying }: { what: string; onRetry: () => void; retrying: boolean }) {
	return (
		<div role="alert" className="text-dense text-foreground-muted flex items-center gap-2 px-2 py-1">
			Couldn't load {what}.
			<Button type="button" variant="ghost" size="xs" onClick={onRetry} disabled={retrying}>
				{retrying ? 'Trying again…' : 'Try again'}
			</Button>
		</div>
	);
}

/**
 * The chat half of layout/Sidebar.svelte: Pinned chats, the folder tree, and
 * every other chat grouped by when it was last updated, loading more as the
 * list scrolls. Empty, it says what will appear (STA-3); a failed load is
 * shown in place with Try again (STA-4), never as an empty list: only the
 * main list failing outright takes the whole list's place, while pinned
 * chats, the folders or a further page fail where they would be. Folders are
 * shown, and asked for, only when the server has them on and this account
 * may use them (the server refuses otherwise).
 */
export function ChatSidebar({ onNavigate }: { onNavigate?: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const queryClient = useQueryClient();
	const pages = useChatPages();
	const pinned = usePinnedChats();
	const foldersOn = canUseFeature('folders', user, config);
	const folders = useFolders(foldersOn);
	const [creating, setCreating] = useState(false);
	const [showFolders, setShowFolders] = useState(true);
	const list = (pages.data?.pages ?? []).flat();
	const allFolders = folders.data ?? [];

	const createFolder = async (v: { name: string; system_prompt: string }, parentId?: string) => {
		const res = await createNewFolder(token, {
			name: v.name,
			data: v.system_prompt ? { system_prompt: v.system_prompt } : undefined,
			parent_id: parentId ?? null
		}).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) {
			toast.success('Folder created');
			void queryClient.invalidateQueries({ queryKey: ['folders'] });
			setShowFolders(true);
		}
		return Boolean(res);
	};

	if (pages.isError && !pages.data)
		return (
			<section className="mt-2" aria-label="Chats">
				<LoadFailed what="chats" error={pages.error} retrying={pages.isFetching} onRetry={() => void pages.refetch()} />
			</section>
		);
	// The main list leaves out pinned chats and chats in folders, so it is empty
	// only when those are known to be empty too; with folders it says which it holds.
	const empty =
		!pages.isLoading &&
		!pinned.isLoading &&
		!pinned.isError &&
		!(foldersOn && folders.isLoading) &&
		list.length === 0 &&
		(pinned.data?.length ?? 0) === 0;
	const emptyText =
		allFolders.length > 0 || folders.isError ? 'Chats outside folders appear here.' : 'Your chats will appear here.';
	const nextFailed = pages.isFetchNextPageError;

	return (
		<section className="mt-2 flex flex-col gap-1" aria-label="Chats">
			{pinned.isError ? (
				<section>
					<div className={sectionHeader}>Pinned</div>
					<InlineFailed what="pinned chats" onRetry={() => void pinned.refetch()} retrying={pinned.isFetching} />
				</section>
			) : (
				(pinned.data?.length ?? 0) > 0 && (
					<section>
						<div className={sectionHeader}>Pinned</div>
						{(pinned.data ?? []).map((c) => (
							<ChatItem key={c.id} chat={c} folders={allFolders} onNavigate={onNavigate} />
						))}
					</section>
				)
			)}

			{foldersOn && (
				<section>
					<div className="group flex items-center">
						<Button
							type="button"
							variant="ghost"
							size="xs"
							className={cn('w-full min-w-0 shrink justify-start', DISCLOSURE)}
							aria-expanded={showFolders}
							onClick={() => setShowFolders((s) => !s)}
						>
							{showFolders ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
							Folders
						</Button>
						<Tip content="New folder">
							<Button
								type="button"
								aria-label="New folder"
								variant="ghost"
								size="icon-xs"
								className="mr-1"
								onClick={() => setCreating(true)}
							>
								<Plus className="size-3.5" />
							</Button>
						</Tip>
					</div>
					{showFolders && folders.isError && (
						<InlineFailed what="folders" onRetry={() => void folders.refetch()} retrying={folders.isFetching} />
					)}
					{showFolders && !folders.isLoading && !folders.isError && allFolders.length === 0 && (
						<p className="text-foreground-muted text-caption px-2 pb-1">
							Group chats and give them shared instructions.
						</p>
					)}
					{showFolders && (
						<ul aria-label="Folders">
							{folderTree(allFolders).map((f) => (
								<FolderItem
									key={f.id}
									node={f}
									folders={allFolders}
									depth={0}
									onNavigate={onNavigate}
									onCreateChild={createFolder}
								/>
							))}
						</ul>
					)}
					<FolderDialog open={creating} onOpenChange={setCreating} onSave={(v) => createFolder(v)} />
				</section>
			)}

			<section aria-label="Chat list">
				{empty && <p className="text-foreground-muted text-dense px-2 py-1">{emptyText}</p>}
				{pages.isLoading && (
					<div className="flex justify-center py-3">
						<Spinner className="size-4" />
					</div>
				)}
				{groupByTimeRange(list).map((g) => (
					<div key={g.label} className="mb-1">
						<div className={sectionHeader}>{g.label}</div>
						{g.chats.map((c) => (
							<ChatItem key={c.id} chat={c} folders={allFolders} onNavigate={onNavigate} />
						))}
					</div>
				))}
				{nextFailed && (
					<InlineFailed
						what="more chats"
						onRetry={() => void pages.fetchNextPage()}
						retrying={pages.isFetchingNextPage}
					/>
				)}
				{pages.hasNextPage && !nextFailed && (
					<InfiniteLoader onVisible={() => !pages.isFetchingNextPage && void pages.fetchNextPage()}>
						<div className="flex justify-center py-2">
							<Spinner className="size-4" />
						</div>
					</InfiniteLoader>
				)}
			</section>
		</section>
	);
}

/** Ports RecursiveFolder.svelte and FolderMenu.svelte: a folder, its chats when expanded, its subfolders, and its menu. */
function FolderItem({
	node,
	folders,
	depth,
	onNavigate,
	onCreateChild
}: {
	node: FolderNode;
	folders: Folder[];
	depth: number;
	onNavigate?: () => void;
	onCreateChild: (v: { name: string; system_prompt: string }, parentId: string) => Promise<boolean>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(Boolean(node.is_expanded));
	const [editing, setEditing] = useState(false);
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const chats = useFolderChats(node.id, open);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['folders'] });
		void queryClient.invalidateQueries({ queryKey: ['chats'] });
	};

	const toggle = () => {
		setOpen((o) => !o);
		void updateFolderIsExpandedById(token, node.id, !open).catch(() => {});
	};

	return (
		<li>
			<div className={rowClass} style={{ paddingLeft: depth * 12 }}>
				<Button
					type="button"
					aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
					aria-expanded={open}
					variant="ghost"
					size="icon-xs"
					className={DISCLOSURE}
					onClick={toggle}
				>
					{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				</Button>
				<NavLink
					to={`/folders/${node.id}`}
					onClick={onNavigate}
					className={({ isActive }) =>
						cn(
							'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 pr-7 text-sm pointer-coarse:min-h-11 pointer-coarse:pr-12',
							isActive ? 'bg-accent' : 'hover:bg-accent/50'
						)
					}
				>
					<FolderIcon className="size-3.5 shrink-0" />
					<span className="truncate" title={node.name}>
						{node.name}
					</span>
				</NavLink>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							aria-label={`Folder menu: ${node.name}`}
							variant="ghost"
							size="icon-xs"
							className={rowMenuButtonClass}
						>
							<MoreHorizontal className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-52">
						<DropdownMenuItem onSelect={() => setCreating(true)}>
							<FolderPlus /> New subfolder
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={async () => {
								await markFolderChatsReadById(token, node.id).catch((e) => toast.error(`${e}`));
								refresh();
							}}
						>
							<CheckCheck /> Mark all as read
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setEditing(true)}>
							<Pencil /> Edit folder
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
							<Trash2 /> Delete folder
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{open && (
				<div style={{ paddingLeft: depth * 12 + 16 }}>
					{node.children.length > 0 && (
						<ul>
							{node.children.map((c) => (
								<FolderItem
									key={c.id}
									node={c}
									folders={folders}
									depth={0}
									onNavigate={onNavigate}
									onCreateChild={onCreateChild}
								/>
							))}
						</ul>
					)}
					{chats.isError && (
						<InlineFailed what="this folder's chats" onRetry={() => void chats.refetch()} retrying={chats.isFetching} />
					)}
					{chats.isLoading ? (
						<Spinner className="m-2 size-3.5" />
					) : (
						(chats.data?.pages ?? [])
							.flat()
							.map((c) => <ChatItem key={c.id} chat={c} folders={folders} folderId={node.id} onNavigate={onNavigate} />)
					)}
					{!chats.isLoading && !chats.isError && !(chats.data?.pages ?? []).flat().length && !node.children.length && (
						<p className="text-foreground-muted text-caption px-2 py-1">No chats yet. Move one here from its menu.</p>
					)}
					{chats.hasNextPage && (
						<Button type="button" variant="ghost" size="xs" onClick={() => void chats.fetchNextPage()}>
							Show more
						</Button>
					)}
				</div>
			)}
			<FolderDialog open={creating} onOpenChange={setCreating} onSave={(v) => onCreateChild(v, node.id)} />
			<FolderDialog
				open={editing}
				onOpenChange={setEditing}
				folder={node}
				onSave={async (v) => {
					const res = await updateFolderById(token, node.id, {
						name: v.name,
						data: { ...(node.data ?? {}), system_prompt: v.system_prompt }
					}).catch((e) => {
						toast.error(`${e}`);
						return null;
					});
					if (res) {
						toast.success('Folder updated');
						refresh();
					}
					return Boolean(res);
				}}
			/>
			<DeleteFolderDialog
				open={deleting}
				onOpenChange={setDeleting}
				folder={node}
				onDelete={async (withContents) => {
					const ok = await deleteFolderById(token, node.id, withContents).then(
						() => true,
						(e) => {
							toast.error(`${e}`);
							return false;
						}
					);
					if (ok) toast.success('Folder deleted');
					refresh();
				}}
			/>
		</li>
	);
}
