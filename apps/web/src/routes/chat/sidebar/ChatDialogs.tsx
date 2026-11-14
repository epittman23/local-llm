import { useQuery } from '@tanstack/react-query';
import { Link2, MessageSquare, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
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
import { type AccessGrant, DROPPED_GRANTS_WARNING, grantsDropped } from '@/lib/access/accessGrants';
import {
	deleteSharedChatById,
	getChatAccessGrants,
	getChatById,
	getChatListBySearchText,
	shareChatById,
	updateChatAccessGrants
} from '@/lib/apis/chats';
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
 * existing link can be deleted. Not ported: sharing to the original project's
 * community site.
 */
export function ShareChatDialog({ open, onOpenChange, chatId }: DialogProps & { chatId: string }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const chat = useQuery({
		queryKey: ['chat-share', chatId],
		enabled: open,
		queryFn: async () => (await getChatById(token, chatId)) as { share_id?: string | null }
	});
	const [busy, setBusy] = useState(false);
	const shared = Boolean(chat.data?.share_id);

	// Who can open the link (#334). A share starts private: the shared-chat route
	// serves it only to its owner and the users and groups granted read here, as
	// ShareChatModal.svelte's AccessControl panel set them.
	const [grants, setGrants] = useState<AccessGrant[] | null>(null);
	// What the server last said it stored: the panel goes back to it when a save fails.
	const saved = useRef<AccessGrant[]>([]);
	useEffect(() => {
		if (!open || !shared) return;
		let current = true;
		getChatAccessGrants(token, chatId)
			.then((stored) => {
				if (!current) return;
				saved.current = Array.isArray(stored) ? (stored as AccessGrant[]) : [];
				setGrants(saved.current);
			})
			.catch((e) => current && toast.error(`${e}`));
		return () => {
			current = false;
		};
	}, [open, shared, token, chatId]);

	// Shown at once. Each save waits for the one before it, so the server applies
	// them in order: it replaces the grants wholesale, and two in flight together
	// could be stored either way round. Only the latest save's re-read is shown,
	// since the server drops grants this user may not set (as #522).
	const accessSaves = useRef(0);
	const saveChain = useRef<Promise<unknown>>(Promise.resolve());
	const saveAccess = (next: AccessGrant[]) => {
		const seq = ++accessSaves.current;
		setGrants(next);
		const run = async () => {
			const ok = await updateChatAccessGrants(token, chatId, next).then(
				() => true,
				(e) => void toast.error(`${e}`)
			);
			const latest = () => accessSaves.current === seq;
			if (!ok) {
				if (latest()) setGrants(saved.current);
				return;
			}
			const stored = await getChatAccessGrants(token, chatId).catch(() => null);
			if (!Array.isArray(stored)) {
				if (latest()) toast.error('Saved, but the access could not be read back. Reopen the dialog to check it.');
				return;
			}
			saved.current = stored as AccessGrant[];
			if (!latest()) return;
			setGrants(saved.current);
			if (grantsDropped(next, stored)) toast.warning(DROPPED_GRANTS_WARNING);
			else toast.success('Access updated');
		};
		saveChain.current = saveChain.current.then(run, run);
		return saveChain.current;
	};

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
		// A new link opens to no one but its owner, so the dialog stays to say who else may.
		if (shared) onOpenChange(false);
		void chat.refetch();
	};
	const unshare = async () => {
		const deleted = await deleteSharedChatById(token, chatId).then(
			() => true,
			(e) => void toast.error(`${e}`)
		);
		if (deleted) {
			// The link and its grants are gone; a save still in flight must not show them again.
			accessSaves.current += 1;
			saved.current = [];
			setGrants(null);
		}
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
								<Button type="button" variant="link" className="h-auto p-0" onClick={unshare}>
									Delete this link
								</Button>{' '}
								to stop sharing, or update it with the chat as it is now. Choose below who can open it.
							</>
						) : (
							'Messages you send after creating your link won’t be shared. Once the link exists, you choose who can open it.'
						)}
					</DialogDescription>
				</DialogHeader>
				{shared && grants !== null && (
					<AccessControl
						accessGrants={grants}
						onChange={(next) => void saveAccess(next)}
						accessRoles={['read']}
						sharePublic={Boolean(user?.permissions?.sharing?.public_chats) || isAdmin}
						shareOpen={Boolean(user?.permissions?.sharing?.open_chats) || isAdmin}
						shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
					/>
				)}
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
						<Button type="button" variant="ghost" className="w-full justify-start" onClick={() => go('/')}>
							<MessageSquare className="size-4" /> Start a new conversation
						</Button>
					) : results.isLoading ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-4" />
						</div>
					) : !results.data?.length ? (
						<p className="text-muted-foreground px-2 py-6 text-center text-sm">No results found</p>
					) : (
						results.data.map((c) => (
							<Button
								key={c.id}
								type="button"
								role="option"
								aria-selected={false}
								variant="ghost"
								className="w-full justify-between"
								onClick={() => go(`/c/${c.id}`)}
							>
								<span className="truncate">{c.title}</span>
								<span className="text-muted-foreground shrink-0 text-xs">{c.time_range}</span>
							</Button>
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
