import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Copy, Globe, Link2, Link2Off, Lock, RefreshCw, SquarePen } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import {
	type AccessGrant,
	DROPPED_GRANTS_WARNING,
	grantsDropped,
	hasAnyoneReadGrant,
	setVisibility
} from '@/lib/access/accessGrants';
import {
	deleteSharedChatById,
	getChatAccessGrants,
	getChatById,
	getChatListBySearchText,
	shareChatById,
	updateChatAccessGrants
} from '@/lib/apis/chats';
import { searchUsers } from '@/lib/apis/users';
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

type Audience = 'anyone' | 'me';

/** What each answer to "Who can open the link" means, shown under the choice. */
const AUDIENCE_HELP: Record<Audience | '', string> = {
	'': 'Anyone with the link: no sign-in needed. Only me: it opens only while you are signed in, such as on your other devices.',
	anyone: 'Anyone you send the link to can read this chat without signing in.',
	me: 'The link opens only while you are signed in, such as on your other devices.'
};

/**
 * Ports chat/ShareChatModal.svelte, asking first (#1006, S2-D2): before a link
 * exists the dialog asks who can open it, "Anyone with the link" or "Only me
 * (signed in)", with nothing preselected and nothing created until one is
 * chosen. Then it shows the link in a read-only field with Copy link, Update
 * snapshot (shares the chat again as it is now) and Stop sharing.
 *
 * The answer is stored as the share's access grants (#334) through the
 * existing routes: "anyone" is the `anyone:*` read grant (`getVisibility`'s
 * "open"), "only me" is no grant, since the shared-chat route always serves a
 * share to its owner. The users-and-groups list is shown only when more than
 * one account exists (WRD-4), counted by GET /users/search's `total`. Not
 * ported: sharing to the original project's community site.
 */
export function ShareChatDialog({ open, onOpenChange, chatId }: DialogProps & { chatId: string }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const canShareOpen = Boolean(user?.permissions?.sharing?.open_chats) || isAdmin;
	const chat = useQuery({
		queryKey: ['chat-share', chatId],
		enabled: open,
		queryFn: async () => (await getChatById(token, chatId)) as { share_id?: string | null }
	});
	const shareId = chat.data?.share_id ?? null;
	const shared = Boolean(shareId);
	// Several accounts make users and groups worth granting; one account never does.
	const accounts = useQuery({
		queryKey: ['account-count'],
		enabled: open && shared,
		queryFn: async () => ((await searchUsers(token)) as { total?: number } | null)?.total ?? 1
	});
	const severalAccounts = (accounts.data ?? 1) > 1;

	// The answer before a link exists: nothing until the owner picks one.
	const [choice, setChoice] = useState<Audience | ''>('');
	const [busy, setBusy] = useState<'create' | 'update' | null>(null);
	useEffect(() => {
		if (open) setChoice('');
	}, [open]);
	const copyButton = useRef<HTMLButtonElement>(null);
	const focusCopy = useRef(false);
	const ids = useId();

	// Who can open the link as stored (#334). A new share starts with no grant: only its owner.
	const [grants, setGrants] = useState<AccessGrant[] | null>(null);
	// What the server last said it stored: the choice goes back to it when a save fails.
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

	// After a link is created its Copy link button takes the focus the Create button had.
	useEffect(() => {
		if (shared && focusCopy.current) {
			focusCopy.current = false;
			copyButton.current?.focus();
		}
	}, [shared]);

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

	const create = async () => {
		if (!choice) return;
		setBusy('create');
		const res = (await shareChatById(token, chatId).catch((e) => {
			toast.error(`${e}`);
			return null;
		})) as { share_id?: string } | null;
		if (!res?.share_id) {
			setBusy(null);
			return;
		}
		// The link exists and opens to its owner alone; "anyone" is granted next, and
		// the link is copied only once the server says it stored that grant.
		let stored: AccessGrant[] = [];
		if (choice === 'anyone') {
			const ok = await updateChatAccessGrants(token, chatId, setVisibility([], 'open')).then(
				() => true,
				() => false
			);
			const readBack = ok ? await getChatAccessGrants(token, chatId).catch(() => null) : null;
			stored = Array.isArray(readBack) ? (readBack as AccessGrant[]) : [];
		}
		accessSaves.current += 1;
		saved.current = stored;
		setGrants(stored);
		setBusy(null);
		focusCopy.current = true;
		if (choice === 'anyone' && !hasAnyoneReadGrant(stored)) {
			toast.error('The link was created, but only you can open it: opening it to anyone was not saved.');
		} else {
			await copyToClipboard(shareUrl(res.share_id));
			toast.success('Link copied');
		}
		void chat.refetch();
	};
	const copyLink = async () => {
		if (!shareId) return;
		await copyToClipboard(shareUrl(shareId));
		toast.success('Link copied');
	};
	const updateSnapshot = async () => {
		setBusy('update');
		const res = (await shareChatById(token, chatId).catch((e) => {
			toast.error(`${e}`);
			return null;
		})) as { share_id?: string } | null;
		setBusy(null);
		if (res?.share_id) toast.success('Snapshot updated: the link shows the chat as it is now');
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
			setChoice('');
		}
		void chat.refetch();
	};

	// Before a link exists the owner's pick; after, what is stored.
	const audience: Audience | '' = shared
		? grants === null
			? ''
			: hasAnyoneReadGrant(grants)
				? 'anyone'
				: 'me'
		: choice;
	const pick = (next: Audience) => {
		if (!shared) setChoice(next);
		else if (grants !== null) void saveAccess(setVisibility(grants, next === 'anyone' ? 'open' : 'private'));
	};
	const anyoneBlocked = !canShareOpen && audience !== 'anyone';
	const help = `${AUDIENCE_HELP[audience]}${anyoneBlocked ? ' Your sharing permissions do not allow links that anyone can open.' : ''}`;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* OVL-1: 32 rem, a short form; the two answers then fit side by side. */}
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Share chat</DialogTitle>
					<DialogDescription>
						{shared
							? 'The link shows the chat as it was when it was last shared. Update the snapshot to add what was said since.'
							: 'The link will show the chat as it is now. Messages you send later are not in it until you update the snapshot.'}
					</DialogDescription>
				</DialogHeader>
				<div className="flex min-w-0 flex-col gap-4">
					<div>
						<p id={`${ids}-who`} className="text-foreground-strong font-strong mb-1.5">
							Who can open the link
						</p>
						<SegmentedControl<Audience | ''>
							aria-labelledby={`${ids}-who`}
							aria-describedby={`${ids}-who-help`}
							value={audience}
							onValueChange={(v) => v && pick(v)}
							// On a phone the icons go, so each answer stays on one line.
							className="w-full max-sm:[&_svg]:hidden sm:grid sm:grid-cols-2"
							options={[
								{ value: 'anyone', label: 'Anyone with the link', icon: Globe, disabled: anyoneBlocked },
								{ value: 'me', label: 'Only me (signed in)', icon: Lock }
							]}
						/>
						<p id={`${ids}-who-help`} className="text-foreground-muted mt-1 text-dense">
							{help}
						</p>
					</div>
					{shareId && (
						<div className="min-w-0">
							<Label htmlFor={`${ids}-url`}>Link</Label>
							<div className="mt-1.5 flex min-w-0 gap-2">
								<Input
									id={`${ids}-url`}
									readOnly
									value={shareUrl(shareId)}
									onFocus={(e) => e.currentTarget.select()}
									className="min-w-0 flex-1"
								/>
								<Button ref={copyButton} variant="outline" onClick={copyLink}>
									<Copy aria-hidden /> Copy link
								</Button>
							</div>
						</div>
					)}
					{shared && severalAccounts && grants !== null && (
						<AccessControl
							accessGrants={grants}
							onChange={(next) => void saveAccess(next)}
							accessRoles={['read']}
							showVisibility={false}
							shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
						/>
					)}
				</div>
				<DialogFooter>
					{shared ? (
						<>
							<Button variant="outline" className="text-danger sm:mr-auto" onClick={unshare}>
								<Link2Off aria-hidden /> Stop sharing
							</Button>
							<Button
								variant="outline"
								onClick={updateSnapshot}
								disabled={busy !== null}
								aria-busy={busy === 'update' || undefined}
							>
								{busy === 'update' ? <Spinner className="size-3.5" /> : <RefreshCw aria-hidden />}
								{busy === 'update' ? 'Updating…' : 'Update snapshot'}
							</Button>
						</>
					) : (
						<>
							{!choice && (
								<p id={`${ids}-why`} className="text-foreground-muted self-center text-dense sm:mr-auto">
									Choose who can open the link first.
								</p>
							)}
							<Button
								onClick={create}
								disabled={!choice || busy !== null || chat.isLoading}
								aria-describedby={choice ? undefined : `${ids}-why`}
								aria-busy={busy === 'create' || undefined}
							>
								{busy === 'create' ? <Spinner className="size-3.5" /> : <Link2 aria-hidden />}
								{busy === 'create' ? 'Creating…' : 'Create and copy link'}
							</Button>
						</>
					)}
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
