import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getChatList, getChatListByFolderId, getPinnedChatList } from '@/lib/apis/chats';
import { getFolders } from '@/lib/apis/folders';
import type { ChatListItem, Folder } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';

// The Svelte `chats`, `pinnedChats` and folder stores as TanStack queries.
// Everything chat-related lives under ['chats', ...], so invalidating
// ['chats'] (what useChatSession does when a reply ends or a title arrives)
// refreshes the list, the pinned chats and every open folder at once.

// A failed load throws, so the sidebar shows it in place (STA-4) instead of
// an empty list.

const asList = (r: unknown) => (Array.isArray(r) ? (r as ChatListItem[]) : []);

/** How many chats a page of the main list holds (routers/chats.py, `get_session_user_chat_list`). */
export const CHAT_PAGE_SIZE = 60;
/** How many chats a page of a folder holds (routers/chats.py, `get_chat_list_by_folder_id`). */
export const FOLDER_PAGE_SIZE = 10;

/** The next page's number, or undefined when the last page was short, so there is no more (#1070). */
export const nextPage = (size: number) => (last: unknown[], pages: unknown[][]) =>
	last.length < size ? undefined : pages.length + 1;

export function useChatPages() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useInfiniteQuery({
		queryKey: ['chats', 'list'],
		enabled: Boolean(token),
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => asList(await getChatList(token, pageParam)),
		getNextPageParam: nextPage(CHAT_PAGE_SIZE)
	});
}

export function usePinnedChats() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['chats', 'pinned'],
		enabled: Boolean(token),
		queryFn: async () => asList(await getPinnedChatList(token))
	});
}

export function useFolderChats(folderId: string, enabled: boolean) {
	const token = useAuthStore((s) => s.token) ?? '';
	return useInfiniteQuery({
		queryKey: ['chats', 'folder', folderId],
		enabled: enabled && Boolean(token),
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => asList(await getChatListByFolderId(token, folderId, pageParam)),
		getNextPageParam: nextPage(FOLDER_PAGE_SIZE)
	});
}

/** The folders, under ['folders'] (the key Automations already reads). */
export function useFolders() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['folders'],
		enabled: Boolean(token),
		queryFn: async () => ((l: unknown) => (Array.isArray(l) ? (l as Folder[]) : []))(await getFolders(token))
	});
}

/** Applies `fn` to a chat wherever it appears in the cached lists (list pages, pinned, folders). */
export function patchCachedChat(queryClient: QueryClient, id: string, fn: (c: ChatListItem) => ChatListItem) {
	for (const [key, data] of queryClient.getQueriesData<unknown>({ queryKey: ['chats'] })) {
		if (Array.isArray(data))
			queryClient.setQueryData(
				key,
				(data as ChatListItem[]).map((c) => (c.id === id ? fn(c) : c))
			);
		else if (data && typeof data === 'object' && 'pages' in data) {
			const inf = data as InfiniteData<ChatListItem[]>;
			queryClient.setQueryData(key, { ...inf, pages: inf.pages.map((p) => p.map((c) => (c.id === id ? fn(c) : c))) });
		}
	}
}
