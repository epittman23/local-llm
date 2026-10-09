import { useQuery } from '@tanstack/react-query';
import { Link2, MessageSquare, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { deleteSharedChatById, getChatById, getChatListBySearchText, shareChatById } from '@/lib/apis/chats';
import type { ChatListItem, Folder } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { copyToClipboard } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { appHref } from '@/routes/routePaths';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** The public link to a shared chat (the app's own /s/<id> page). */
export const shareUrl = (shareId: string) => `${window.location.origin}${appHref(`/s/${shareId}`)}`;

/**
 * Ports chat/ShareChatModal.svelte: Copy Link shares the chat as it is now
 * (again, if it was shared before, which updates the snapshot), and an
 * existing link can be deleted. Not ported: sharing to the openwebui.com
 * community site.
 */
export function ShareChatDialog({ open, onOpenChange, chatId }: DialogProps & { chatId: string }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const chat = useQuery({
		queryKey: ['chat-share', chatId],
		enabled: open,
		queryFn: async () => (await getChatById(token, chatId)) as { share_id?: string | null }
	});
	const [busy, setBusy] = useState(false);
	const shared = Boolean(chat.data?.share_id);

	const copy = async () => {
		setBusy(true);
		const res = (await shareChatById(token, chatId).catch((e) => {
			toast.error(`${e}`);
			return null;
		})) as { share_id?: string } | null;
		setBusy(false);
		if (!res?.share_id) return;
		await copyToClipboard(shareUrl(res.share_id));
		toast.success('Copied shared chat URL to clipboard!');
		void chat.refetch();
		onOpenChange(false);
	};
	const unshare = async () => {
		await deleteSharedChatById(token, chatId).catch((e) => toast.error(`${e}`));
		void chat.refetch();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Share Chat</DialogTitle>
					<DialogDescription>
						{shared ? (
							<>
								You have shared this chat before.{' '}
								<button type="button" className="underline" onClick={unshare}>
									Delete this link
								</button>{' '}
								to stop sharing, or update it with the chat as it is now.
							</>
						) : (
							'Messages you send after creating your link won’t be shared. Users with the URL will be able to view the shared chat.'
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button onClick={copy} disabled={busy || chat.isLoading}>
						<Link2 className="size-4" /> {shared ? 'Update and Copy Link' : 'Copy Link'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports layout/SearchModal.svelte's search: chats matching the text (the
 * server also understands `tag:`, `folder:`, `pinned:` and similar filters),
 * newest first; choosing one opens it.
 */
export function SearchChatsDialog({ open, onOpenChange }: DialogProps) {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [query, setQuery] = useState('');
	const q = useDebouncedValue(query.trim(), 250);
	useEffect(() => {
		if (!open) setQuery('');
	}, [open]);
	const results = useQuery({
		queryKey: ['chats', 'search', q],
		enabled: open && q.length > 0,
		queryFn: async () => ((await getChatListBySearchText(token, q, 1).catch(() => [])) ?? []) as ChatListItem[]
	});
	const go = (path: string) => {
		onOpenChange(false);
		navigate(path);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg p-3">
				<DialogHeader className="sr-only">
					<DialogTitle>Search chats</DialogTitle>
					<DialogDescription>Search your chats by text or filters</DialogDescription>
				</DialogHeader>
				<div className="relative">
					<Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
					<Input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search"
						aria-label="Search chats"
						className="pl-8"
					/>
				</div>
				<div className="max-h-96 overflow-y-auto" role="listbox" aria-label="Search results">
					{!q ? (
						<button
							type="button"
							className="hover:bg-muted flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
							onClick={() => go('/')}
						>
							<MessageSquare className="size-4" /> Start a new conversation
						</button>
					) : results.isLoading ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-4" />
						</div>
					) : !results.data?.length ? (
						<p className="text-muted-foreground px-2 py-6 text-center text-sm">No results found</p>
					) : (
						results.data.map((c) => (
							<button
								key={c.id}
								type="button"
								role="option"
								aria-selected={false}
								className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm"
								onClick={() => go(`/c/${c.id}`)}
							>
								<span className="truncate">{c.title}</span>
								<span className="text-muted-foreground shrink-0 text-xs">{c.time_range}</span>
							</button>
						))
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports Folders/FolderModal.svelte's name and system prompt (a folder's
 * system prompt applies to every chat in it; the server adds it). Not ported:
 * the background image and the folder's knowledge files.
 */
export function FolderDialog({
	open,
	onOpenChange,
	folder,
	onSave
}: DialogProps & { folder?: Folder | null; onSave: (v: { name: string; system_prompt: string }) => Promise<boolean> }) {
	const [name, setName] = useState('');
	const [prompt, setPrompt] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!open) return;
		setName(folder?.name ?? '');
		setPrompt(String(folder?.data?.system_prompt ?? ''));
	}, [open, folder]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{folder ? 'Edit Folder' : 'Create Folder'}</DialogTitle>
					<DialogDescription className="sr-only">Folder name and system prompt</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!name.trim()) {
							toast.error('Folder name cannot be empty.');
							return;
						}
						setBusy(true);
						const ok = await onSave({ name: name.trim(), system_prompt: prompt });
						setBusy(false);
						if (ok) onOpenChange(false);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="folder-name">Folder Name</Label>
						<Input
							id="folder-name"
							autoFocus
							placeholder="Enter folder name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="folder-prompt">System Prompt</Label>
						<Textarea
							id="folder-prompt"
							placeholder="Write your model system prompt content here"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
						/>
					</div>
					<DialogFooter>
						<Button type="submit" disabled={busy}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** RecursiveFolder.svelte's delete confirmation, with "delete everything inside" as an explicit choice. */
export function DeleteFolderDialog({
	open,
	onOpenChange,
	folder,
	onDelete
}: DialogProps & { folder: Folder; onDelete: (withContents: boolean) => void }) {
	const [contents, setContents] = useState(false);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Delete folder?</DialogTitle>
					<DialogDescription>Are you sure you want to delete "{folder.name}"?</DialogDescription>
				</DialogHeader>
				<label className="flex items-center gap-2 text-sm">
					<Checkbox
						checked={contents}
						onCheckedChange={(v) => setContents(v === true)}
						aria-label="Delete all contents inside this folder"
					/>
					Delete all contents inside this folder
				</label>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => {
							onDelete(contents);
							onOpenChange(false);
						}}
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
