import { useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Archive, Download, MoreHorizontal, Pencil, Pin, PinOff, Share2, Tag, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Tags } from '@/components/common/Tags';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { addTagById, archiveChatById, deleteChatById, deleteTagById, getAllTags, getChatById } from '@/lib/apis/chats';
import { chatAsMarkdown, chatAsText, fileSafe } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatTags } from './ChatTitle';
import { ShareChatDialog } from './sidebar/ChatDialogs';
import { usePinChat } from './sidebar/usePinChat';

type Format = 'md' | 'txt' | 'json';

/**
 * Ports the chat header's menu (chat/Navbar.svelte + layout/Navbar/Menu.svelte)
 * for a saved chat, offering what the sidebar row does (#928): Rename, Pin,
 * Tags, Share, Download (Markdown, plain text or JSON, #1085), then Archive
 * and Delete (OVL-3). The PDF download is not ported (as in the sidebar's
 * menu). Controls is not here: its button sits beside the menu.
 */
export function ChatMenu({
	chatId,
	title,
	onRename,
	size = 'icon-sm'
}: {
	chatId: string;
	title: string;
	/** Rename chosen: the page shows its title's editor (or a dialog, on a phone). */
	onRename: () => void;
	/** The trigger's size: the phone bar's buttons are `icon`. */
	size?: 'icon' | 'icon-sm';
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { pinned, toggle: togglePin } = usePinChat(chatId);
	const [share, setShare] = useState(false);
	const [tags, setTags] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	// Rename moves focus to the title's editor, so it waits until the menu has
	// closed and handed focus back to its trigger; an editor shown while the
	// menu is open would lose focus to it.
	const renameOnClose = useRef(false);

	const leave = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			void queryClient.invalidateQueries({ queryKey: ['chats'] });
			navigate('/');
		} catch (e) {
			toast.error(`${e}`);
		}
	};
	const download = async (format: Format) => {
		const full = await getChatById(token, chatId).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (!full) return;
		const name = `chat-${fileSafe(full.chat?.title ?? title)}.${format}`;
		if (format === 'json') saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), name);
		else if (format === 'md') saveAs(new Blob([chatAsMarkdown(full)], { type: 'text/markdown' }), name);
		else saveAs(new Blob([chatAsText(full)], { type: 'text/plain' }), name);
	};

	return (
		<>
			<DropdownMenu>
				<Tip content="Chat menu">
					<DropdownMenuTrigger asChild>
						<Button type="button" aria-label="Chat menu" variant="ghost" size={size}>
							<MoreHorizontal className="size-4" />
						</Button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent
					align="end"
					className="w-48"
					onCloseAutoFocus={() => {
						if (!renameOnClose.current) return;
						renameOnClose.current = false;
						onRename();
					}}
				>
					<DropdownMenuItem
						onSelect={() => {
							renameOnClose.current = true;
						}}
					>
						<Pencil /> Rename
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void togglePin()}>
						{pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setTags(true)}>
						<Tag /> Tags…
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setShare(true)}>
						<Share2 /> Share
					</DropdownMenuItem>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<Download /> Download
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem onSelect={() => void download('md')}>Markdown (.md)</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void download('txt')}>Plain text (.txt)</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void download('json')}>JSON (.json)</DropdownMenuItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => void leave(() => archiveChatById(token, chatId))}>
						<Archive /> Archive
					</DropdownMenuItem>
					<DropdownMenuItem id="delete-chat-button" variant="destructive" onSelect={() => setConfirmDelete(true)}>
						<Trash2 /> Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{share && <ShareChatDialog open={share} onOpenChange={setShare} chatId={chatId} />}
			{tags && <ChatTagsDialog open={tags} onOpenChange={setTags} chatId={chatId} title={title} />}
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete chat?"
				confirmLabel="Delete chat"
				destructive
				onConfirm={() => void leave(() => deleteChatById(token, chatId))}
			>
				This deletes <strong>{title || 'this chat'}</strong> and its messages. It can't be undone.
			</ConfirmDialog>
		</>
	);
}

/** The chat's tags, added and removed in place (a short form, OVL-1), with the tags already in use suggested. */
function ChatTagsDialog({
	open,
	onOpenChange,
	chatId,
	title
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	chatId: string;
	title: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const tags = useChatTags(chatId);
	const all = useQuery({
		queryKey: ['chats', 'all-tags'],
		enabled: Boolean(token),
		queryFn: async () => {
			const res = await getAllTags(token);
			return (Array.isArray(res) ? res : []) as { name: string }[];
		}
	});
	const change = async (fn: () => Promise<unknown>) => {
		await fn().catch((e) => toast.error(`${e}`));
		void queryClient.invalidateQueries({ queryKey: ['chats'] });
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Tags</DialogTitle>
					<DialogDescription>
						Tags for <strong>{title || 'this chat'}</strong>. Type a tag and press Enter to add it.
					</DialogDescription>
				</DialogHeader>
				<Tags
					tags={tags.data ?? []}
					suggestionTags={all.data ?? []}
					onAdd={(name) => void change(() => addTagById(token, chatId, name))}
					onDelete={(name) => void change(() => deleteTagById(token, chatId, name))}
				/>
			</DialogContent>
		</Dialog>
	);
}
