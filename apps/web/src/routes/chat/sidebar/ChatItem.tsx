import { useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import {
	Archive,
	Copy,
	Download,
	FolderInput,
	MailOpen,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff,
	Share2,
	Trash2
} from 'lucide-react';
import { useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
	archiveChatById,
	cloneChatById,
	deleteChatById,
	getChatById,
	markChatUnreadById,
	toggleChatPinnedStatusById,
	updateChatById,
	updateChatFolderIdById
} from '@/lib/apis/chats';
import { type ChatListItem, type Folder, chatAsText, fileSafe, isUnread } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { ShareChatDialog } from './ChatDialogs';
import { patchCachedChat } from './useChatList';

/**
 * Ports layout/Sidebar/ChatItem.svelte and ChatMenu.svelte: a chat's link
 * (bold with a dot when unread), double-click or Rename to rename in place,
 * and its menu: Share, Download (JSON or text), Rename, Mark as unread,
 * Pin/Unpin, Clone, Move to a folder, Archive, Delete. The PDF download is
 * not ported (it drew the chat into a canvas with jsPDF). Moving uses the
 * menu; the Svelte sidebar's drag-and-drop is not ported (it is not
 * reachable from the keyboard).
 */
export function ChatItem({
	chat,
	folders,
	onNavigate
}: {
	chat: ChatListItem;
	folders: Folder[];
	onNavigate?: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const openId = /^\/c\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(chat.title);
	const [share, setShare] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const unread = isUnread(chat, openId);
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['chats'] });

	const rename = async () => {
		setRenaming(false);
		const next = title.trim();
		if (!next) {
			toast.error('Title cannot be an empty string.');
			setTitle(chat.title);
			return;
		}
		if (next === chat.title) return;
		patchCachedChat(queryClient, chat.id, (c) => ({ ...c, title: next }));
		await updateChatById(token, chat.id, { title: next }).catch((e) => toast.error(`${e}`));
		void refresh();
	};

	const act = async (fn: () => Promise<unknown>, done?: string) => {
		const ok = await fn().then(
			() => true,
			(e) => {
				toast.error(`${e}`);
				return false;
			}
		);
		if (ok && done) toast.success(done);
		void refresh();
		return ok;
	};

	const leaveIfOpen = () => {
		if (openId === chat.id) navigate('/');
	};

	const download = async (kind: 'json' | 'txt') => {
		const full = await getChatById(token, chat.id).catch(() => null);
		if (!full) return;
		if (kind === 'json')
			saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `chat-export-${Date.now()}.json`);
		else
			saveAs(
				new Blob([chatAsText(full)], { type: 'text/plain' }),
				`chat-${fileSafe(full.chat?.title ?? chat.title)}.txt`
			);
	};

	return (
		<div className="group relative" data-testid="chat-item">
			{renaming ? (
				<input
					ref={inputRef}
					autoFocus
					aria-label="Chat title"
					className="bg-accent w-full rounded-md px-2 py-1.5 text-sm outline-none"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={() => void rename()}
					onKeyDown={(e) => {
						if (e.key === 'Enter') void rename();
						if (e.key === 'Escape') {
							setTitle(chat.title);
							setRenaming(false);
						}
					}}
				/>
			) : (
				<NavLink
					to={`/c/${chat.id}`}
					data-chat-link
					onClick={() => {
						patchCachedChat(queryClient, chat.id, (c) => ({ ...c, last_read_at: Math.floor(Date.now() / 1000) }));
						onNavigate?.();
					}}
					onDoubleClick={(e) => {
						e.preventDefault();
						setRenaming(true);
					}}
					className={({ isActive }) =>
						cn(
							'flex items-center gap-1.5 rounded-md px-2 py-1.5 pr-7 text-sm',
							isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
							unread && 'text-foreground font-medium'
						)
					}
				>
					{unread && <span className="size-1.5 shrink-0 rounded-full bg-blue-500" aria-label="Unread" />}
					<span className="truncate">{chat.title}</span>
				</NavLink>
			)}
			{!renaming && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={`Chat menu: ${chat.title}`}
							className="text-muted-foreground hover:text-foreground absolute top-1.5 right-1 hidden rounded p-0.5 group-focus-within:block group-hover:block data-[state=open]:block"
						>
							<MoreHorizontal className="size-4" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-52">
						<DropdownMenuItem onSelect={() => setShare(true)}>
							<Share2 /> Share
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Download className="size-4" /> Download
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuItem onSelect={() => void download('json')}>Export chat (.json)</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => void download('txt')}>Plain text (.txt)</DropdownMenuItem>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem onSelect={() => setRenaming(true)}>
							<Pencil /> Rename
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void act(() => markChatUnreadById(token, chat.id))}>
							<MailOpen /> Mark as unread
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void act(() => toggleChatPinnedStatusById(token, chat.id))}>
							{chat.pinned ? <PinOff /> : <Pin />} {chat.pinned ? 'Unpin' : 'Pin'}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={async () => {
								const res = (await cloneChatById(token, chat.id, `Clone of ${chat.title}`).catch((e) => {
									toast.error(`${e}`);
									return null;
								})) as { id?: string } | null;
								if (res?.id) {
									void refresh();
									navigate(`/c/${res.id}`);
								}
							}}
						>
							<Copy /> Clone
						</DropdownMenuItem>
						{folders.length > 0 && (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<FolderInput className="size-4" /> Move
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
									{chat.folder_id && (
										<DropdownMenuItem
											onSelect={() =>
												void act(() => updateChatFolderIdById(token, chat.id, undefined), 'Chat moved successfully')
											}
										>
											Out of the folder
										</DropdownMenuItem>
									)}
									{folders
										.filter((f) => f.id !== chat.folder_id)
										.map((f) => (
											<DropdownMenuItem
												key={f.id}
												onSelect={() =>
													void act(() => updateChatFolderIdById(token, chat.id, f.id), 'Chat moved successfully')
												}
											>
												{f.name}
											</DropdownMenuItem>
										))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
						<DropdownMenuItem
							onSelect={async () => {
								if (await act(() => archiveChatById(token, chat.id), 'Chat archived.')) leaveIfOpen();
							}}
						>
							<Archive /> Archive
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
							<Trash2 /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{share && <ShareChatDialog open={share} onOpenChange={setShare} chatId={chat.id} />}
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete chat?"
				confirmLabel="Delete"
				onConfirm={async () => {
					if (await act(() => deleteChatById(token, chat.id))) leaveIfOpen();
				}}
			>
				This will delete <strong>{chat.title}</strong>.
			</ConfirmDialog>
		</div>
	);
}
