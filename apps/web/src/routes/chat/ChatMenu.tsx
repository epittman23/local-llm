import { useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Archive, Download, MoreHorizontal, Share2, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Tip } from '@/components/common/Tip';
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
import { archiveChatById, deleteChatById, getChatById } from '@/lib/apis/chats';
import { chatAsText, fileSafe } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { ShareChatDialog } from './sidebar/ChatDialogs';

/**
 * Ports the chat header's menu (chat/Navbar.svelte + layout/Navbar/Menu.svelte)
 * for a saved chat: Controls, Share, Download (JSON or text), Archive, Delete.
 * The PDF download is not ported (as in the sidebar's menu).
 */
export function ChatMenu({ chatId, title, onControls }: { chatId: string; title: string; onControls: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [share, setShare] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const leave = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			void queryClient.invalidateQueries({ queryKey: ['chats'] });
			navigate('/');
		} catch (e) {
			toast.error(`${e}`);
		}
	};
	const download = async (kind: 'json' | 'txt') => {
		const full = await getChatById(token, chatId).catch(() => null);
		if (!full) return;
		if (kind === 'json')
			saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `chat-export-${Date.now()}.json`);
		else
			saveAs(new Blob([chatAsText(full)], { type: 'text/plain' }), `chat-${fileSafe(full.chat?.title ?? title)}.txt`);
	};

	return (
		<>
			<DropdownMenu>
				<Tip content="More">
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="Chat menu"
							className="text-muted-foreground hover:bg-muted rounded-lg p-1.5"
						>
							<MoreHorizontal className="size-4" />
						</button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="end" className="w-48">
					<DropdownMenuItem onSelect={onControls}>
						<SlidersHorizontal /> Controls
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setShare(true)}>
						<Share2 /> Share
					</DropdownMenuItem>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<Download /> Download
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem onSelect={() => void download('json')}>Export chat (.json)</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void download('txt')}>Plain text (.txt)</DropdownMenuItem>
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
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete chat?"
				confirmLabel="Delete"
				onConfirm={() => void leave(() => deleteChatById(token, chatId))}
			>
				This will delete <strong>{title || 'this chat'}</strong>.
			</ConfirmDialog>
		</>
	);
}
