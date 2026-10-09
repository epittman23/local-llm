import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getChatList, getChatListByFolderId, getPinnedChatList } from '@/lib/apis/chats';
import { getFolders } from '@/lib/apis/folders';
import type { ChatListItem, Folder } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';

// The Svelte `chats`, `pinnedChats` and folder stores as TanStack queries.
// Everything chat-related lives under ['chats', ...], so invalidating
// ['chats'] (what useChatSession does when a reply ends or a title arrives)
// refreshes the list, the pinned chats and every open folder at once.

const asList = (r: unknown) => (Array.isArray(r) ? (r as ChatListItem[]) : []);

export function useChatPages() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useInfiniteQuery({
		queryKey: ['chats', 'list'],
		enabled: Boolean(token),
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => asList(await getChatList(token, pageParam).catch(() => [])),
		// The server pages until it returns an empty page.
		getNextPageParam: (last, pages) => (last.length === 0 ? undefined : pages.length + 1)
	});
}

export function usePinnedChats() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['chats', 'pinned'],
		enabled: Boolean(token),
		queryFn: async () => asList(await getPinnedChatList(token).catch(() => []))
	});
}

export function useFolderChats(folderId: string, enabled: boolean) {
	const token = useAuthStore((s) => s.token) ?? '';
	return useInfiniteQuery({
		queryKey: ['chats', 'folder', folderId],
		enabled: enabled && Boolean(token),
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => asList(await getChatListByFolderId(token, folderId, pageParam).catch(() => [])),
		getNextPageParam: (last, pages) => (last.length === 0 ? undefined : pages.length + 1)
	});
}

/** The folders, under ['folders'] (the key Automations already reads). */
export function useFolders() {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['folders'],
		enabled: Boolean(token),
		queryFn: async () =>
			((l: unknown) => (Array.isArray(l) ? (l as Folder[]) : []))(await getFolders(token).catch(() => null))
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
