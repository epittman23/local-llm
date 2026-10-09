import { getOutputText } from './structuredOutput';

// The sidebar's rules for chats and folders (layout/Sidebar.svelte, ChatItem,
// ChatMenu, RecursiveFolder), kept pure for tests.

export type ChatListItem = {
	id: string;
	title: string;
	updated_at?: number;
	created_at?: number;
	last_read_at?: number | null;
	time_range?: string;
	folder_id?: string | null;
	pinned?: boolean;
	[k: string]: unknown;
};
export type Folder = {
	id: string;
	name: string;
	parent_id?: string | null;
	is_expanded?: boolean;
	data?: Record<string, unknown> | null;
	meta?: Record<string, unknown> | null;
	[k: string]: unknown;
};
export type FolderNode = Folder & { children: FolderNode[] };

/**
 * Whether a chat shows as unread (ChatItem.svelte): not the one open, and
 * updated since it was last read (never read counts as unread). `viewedAt` is
 * when this tab last showed it, which also counts as reading.
 */
export function isUnread(chat: ChatListItem, openId: string | null, viewedAt?: number | null): boolean {
	if (chat.id === openId) return false;
	const readAt = Math.max(chat.last_read_at ?? 0, viewedAt ?? 0) || null;
	return readAt === null || (chat.updated_at != null && chat.updated_at > readAt);
}

/** Consecutive chats grouped under their time-range label ("Today", "Previous 7 days", a month...), in list order. */
export function groupByTimeRange(chats: ChatListItem[]): { label: string; chats: ChatListItem[] }[] {
	const groups: { label: string; chats: ChatListItem[] }[] = [];
	for (const c of chats) {
		const label = c.time_range ?? '';
		const last = groups.at(-1);
		if (last && last.label === label) last.chats.push(c);
		else groups.push({ label, chats: [c] });
	}
	return groups;
}

/** Folders as a tree, siblings by name; a folder whose parent is missing is shown at the top level. */
export function folderTree(folders: Folder[]): FolderNode[] {
	const nodes = new Map(folders.map((f) => [f.id, { ...f, children: [] as FolderNode[] }]));
	const roots: FolderNode[] = [];
	for (const n of nodes.values()) {
		const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
		if (parent && parent !== n) parent.children.push(n);
		else roots.push(n);
	}
	const sort = (list: FolderNode[]) => {
		list.sort((a, b) => a.name.localeCompare(b.name));
		list.forEach((n) => sort(n.children));
		return list;
	};
	return sort(roots);
}

/** The folder and everything under it: not valid targets when moving that folder. */
export function descendantIds(folders: Folder[], id: string): Set<string> {
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const f of folders) if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) out.add(f.id), (grew = true);
	}
	return out;
}

type SavedChat = {
	chat?: { title?: string; history?: { messages: Record<string, any>; currentId: string | null }; messages?: any[] };
};

/** A chat as plain text, "### USER / ### ASSISTANT" per message along the current branch (ChatMenu's getChatAsText). */
export function chatAsText(chat: SavedChat): string {
	const history = chat.chat?.history;
	let list: any[] = chat.chat?.messages ?? [];
	if (history?.messages) {
		list = [];
		let id = history.currentId;
		const seen = new Set<string>();
		while (id && history.messages[id] && !seen.has(id)) {
			seen.add(id);
			list.unshift(history.messages[id]);
			id = history.messages[id].parentId;
		}
	}
	return list
		.reduce(
			(text, m) => `${text}### ${String(m.role).toUpperCase()}\n${getOutputText(m.output) || m.content || ''}\n\n`,
			''
		)
		.trim();
}

/** A title safe to use in a file name. */
export const fileSafe = (s: string) => (s || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
