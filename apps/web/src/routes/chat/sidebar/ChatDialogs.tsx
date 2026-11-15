import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Link2, Link2Off, SquarePen } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandLoading } from '@/components/ui/command';
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
import { getTimeRange } from '@/lib/utils/api-helpers';
import { shownTime } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { appHref } from '@/routes/routePaths';
import { useChatPages } from './useChatList';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** The public link to a shared chat (the app's own /s/<id> page). */
export const shareUrl = (shareId: string) => `${window.location.origin}${appHref(`/s/${shareId}`)}`;

/**
 * Ports chat/ShareChatModal.svelte: Copy link shares the chat as it is now
 * (again, if it was shared before, which updates the snapshot), and Stop
 * sharing deletes the link, as a button rather than a phrase in a sentence
 * (#1006). Who can open a new link is still the owner's open question (the
 * link starts private, as before). Not ported: sharing to the original
 * project's community site.
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
		toast.success('Link copied');
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
					<DialogTitle>Share chat</DialogTitle>
					<DialogDescription>
						{shared
							? 'This chat has a link. Copying it again updates the link with the chat as it is now. Choose below who can open it.'
							: 'Messages you send after creating your link won’t be shared. Once the link exists, you choose who can open it.'}
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
					{shared && (
						<Button variant="outline" className="text-danger sm:mr-auto" onClick={unshare}>
							<Link2Off aria-hidden /> Stop sharing
						</Button>
					)}
					<Button onClick={copy} disabled={busy || chat.isLoading}>
						<Link2 aria-hidden /> {shared ? 'Update and copy link' : 'Copy link'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The chats in `list`, under their time headings ("Today", "Previous 7 days"), in the order they came. */
export function groupByTime(list: ChatListItem[]): [string, ChatListItem[]][] {
	const groups = new Map<string, ChatListItem[]>();
	for (const chat of list) {
		const label = chat.time_range ?? getTimeRange(chat.updated_at ?? 0);
		groups.set(label, [...(groups.get(label) ?? []), chat]);
	}
	return [...groups];
}

/** A search that already names its own `archived:` filter gets no second, archived-only search. */
const archivedQuery = (q: string) => (/(^|\s)archived:/.test(q) ? '' : `${q} archived:true`);

/** How many recent chats the empty search offers. */
const RECENT_COUNT = 8;
/** The command list's value for the New chat item, and for an archived chat (kept apart from a live one's id). */
const NEW_CHAT = 'new-chat';
const archivedValue = (chat?: ChatListItem) => (chat ? `archived:${chat.id}` : undefined);

/** One chat in the search list: its title, the matching text when there is any, and when it was last changed. */
function ChatOption({ chat, archived, onOpen }: { chat: ChatListItem; archived?: boolean; onOpen: () => void }) {
	const snippet = typeof chat.snippet === 'string' && chat.snippet ? chat.snippet : null;
	const time = chat.updated_at ? shownTime(chat.updated_at) : null;
	return (
		<CommandItem value={archived ? archivedValue(chat) : chat.id} onSelect={onOpen} className="items-start">
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate" title={chat.title}>
						{chat.title}
					</span>
					{archived && (
						<Badge variant="secondary" className="shrink-0">
							Archived
						</Badge>
					)}
				</span>
				{snippet && <span className="text-dense text-foreground-muted line-clamp-1">{snippet}</span>}
			</span>
			{time && (
				<time dateTime={time.iso} title={time.exact} className="text-caption text-foreground-muted shrink-0 pt-0.5">
					{time.label}
				</time>
			)}
		</CommandItem>
	);
}

/**
 * Ports layout/SearchModal.svelte's search (NAV-5): a command list the arrow
 * keys move through and Enter opens, with the first result highlighted.
 * Before anything is typed it offers the most recent chats. Results are
 * grouped by time, each with the matching text and its date; archived chats
 * that match come last, marked, from a second search with the server's own
 * `archived:true` filter. The server also understands `tag:`, `folder:` and
 * `pinned:`, which the footer says.
 */
export function SearchChatsDialog({ open, onOpenChange }: DialogProps) {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [query, setQuery] = useState('');
	const q = useDebouncedValue(query.trim(), 250);
	useEffect(() => {
		if (!open) setQuery('');
	}, [open]);
	const search = (text: string) => async () =>
		((await getChatListBySearchText(token, text, 1)) ?? []) as ChatListItem[];
	const results = useQuery({
		queryKey: ['chats', 'search', q],
		enabled: open && q.length > 0,
		queryFn: search(q)
	});
	const archivedText = archivedQuery(q);
	const archived = useQuery({
		queryKey: ['chats', 'search', archivedText],
		enabled: open && q.length > 0 && archivedText.length > 0,
		queryFn: search(archivedText)
	});
	const recent = useChatPages();
	const recentChats = (recent.data?.pages[0] ?? []).slice(0, RECENT_COUNT);

	const go = (path: string) => {
		onOpenChange(false);
		navigate(path);
	};
	const typing = query.trim() !== q;
	const found = results.data ?? [];
	const foundArchived = archivedText ? (archived.data ?? []) : [];
	const groups = groupByTime(found);

	// cmdk highlights the first item only when its own filter runs; results that
	// arrive from the server would otherwise start with nothing highlighted, and
	// Enter would do nothing. The first item shown is highlighted instead.
	const first = !q ? (recentChats[0]?.id ?? NEW_CHAT) : (groups[0]?.[1][0]?.id ?? archivedValue(foundArchived[0]));
	const [highlighted, setHighlighted] = useState('');
	useEffect(() => setHighlighted(first ?? ''), [first]);

	let body: ReactNode;
	if (!q) {
		body = (
			<>
				{recentChats.length > 0 && (
					<CommandGroup heading="Recent chats">
						{recentChats.map((c) => (
							<ChatOption key={c.id} chat={c} onOpen={() => go(`/c/${c.id}`)} />
						))}
					</CommandGroup>
				)}
				<CommandGroup heading={recentChats.length ? undefined : 'No chats yet'}>
					<CommandItem value={NEW_CHAT} onSelect={() => go('/')}>
						<SquarePen aria-hidden /> New chat
					</CommandItem>
				</CommandGroup>
			</>
		);
	} else if (results.isError) {
		body = (
			<LoadFailed
				what="search results"
				error={results.error}
				onRetry={() => void results.refetch()}
				retrying={results.isFetching}
			/>
		);
	} else if (typing || results.isLoading) {
		body = (
			<CommandLoading label="Searching chats">
				<div aria-hidden className="flex flex-col gap-2 px-2 py-2">
					{[0, 1, 2].map((i) => (
						<div key={i} className="bg-surface-3 h-8 animate-pulse rounded-lg" />
					))}
				</div>
			</CommandLoading>
		);
	} else if (!found.length && !foundArchived.length) {
		body = (
			<div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
				<p className="text-foreground-muted">No chats match “{q}”.</p>
				<Button variant="outline" size="sm" onClick={() => setQuery('')}>
					Clear search
				</Button>
			</div>
		);
	} else {
		body = (
			<>
				{groups.map(([label, chats]) => (
					<CommandGroup key={label} heading={label}>
						{chats.map((c) => (
							<ChatOption key={c.id} chat={c} onOpen={() => go(`/c/${c.id}`)} />
						))}
					</CommandGroup>
				))}
				{foundArchived.length > 0 && (
					<CommandGroup heading="Archived">
						{foundArchived.map((c) => (
							<ChatOption key={c.id} chat={c} archived onOpen={() => go(`/c/${c.id}`)} />
						))}
					</CommandGroup>
				)}
			</>
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-2 p-3 sm:max-w-lg" showCloseButton={false}>
				<DialogHeader className="sr-only">
					<DialogTitle>Search chats</DialogTitle>
					<DialogDescription>Search your chats by text or filters</DialogDescription>
				</DialogHeader>
				<Command shouldFilter={false} loop label="Search chats" value={highlighted} onValueChange={setHighlighted}>
					<CommandInput value={query} onValueChange={setQuery} placeholder="Search chats" />
					<CommandList label="Search results" className="mt-2">
						{body}
					</CommandList>
					<p className="text-caption text-foreground-muted border-border-divider mt-2 border-t px-1 pt-2">
						↑↓ to move · Enter to open · Filters: tag: folder: pinned:
					</p>
				</Command>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports Folders/FolderModal.svelte's name and system prompt (a folder's
 * system prompt applies to every chat in it; the server adds it), worded as
 * the instructions they are (#1071). An empty name is said at the field
 * (FRM-2), not in a toast. Not ported: the background image and the
 * folder's knowledge files.
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
	const [nameError, setNameError] = useState<string | null>(null);
	const nameField = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!open) return;
		setName(folder?.name ?? '');
		setPrompt(String(folder?.data?.system_prompt ?? ''));
		setNameError(null);
	}, [open, folder]);
	const editing = Boolean(folder);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{editing ? 'Edit folder' : 'New folder'}</DialogTitle>
					<DialogDescription className="sr-only">
						The folder's name and the instructions for its chats
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					noValidate
					onSubmit={async (e) => {
						e.preventDefault();
						if (!name.trim()) {
							setNameError('Enter a name for the folder.');
							nameField.current?.focus();
							return;
						}
						setBusy(true);
						const ok = await onSave({ name: name.trim(), system_prompt: prompt });
						setBusy(false);
						if (ok) onOpenChange(false);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="folder-name">Name</Label>
						<Input
							id="folder-name"
							ref={nameField}
							value={name}
							aria-invalid={nameError ? true : undefined}
							aria-describedby={nameError ? 'folder-name-error' : undefined}
							onChange={(e) => {
								setName(e.target.value);
								if (e.target.value.trim()) setNameError(null);
							}}
						/>
						{nameError && (
							<p id="folder-name-error" className="text-dense text-danger flex items-center gap-1.5">
								<CircleAlert aria-hidden className="size-4 shrink-0" />
								{nameError}
							</p>
						)}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="folder-prompt">Instructions for chats in this folder (optional)</Label>
						<Textarea
							id="folder-prompt"
							value={prompt}
							aria-describedby="folder-prompt-help"
							onChange={(e) => setPrompt(e.target.value)}
						/>
						<p id="folder-prompt-help" className="text-dense text-foreground-muted">
							Added to every chat in this folder.
						</p>
					</div>
					<DialogFooter>
						<Button type="submit" disabled={busy} aria-busy={busy || undefined}>
							{busy && <Spinner className="size-4" />}
							{busy ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save folder' : 'Create folder'}
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
