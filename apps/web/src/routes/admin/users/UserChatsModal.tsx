import { useEffect, useRef, useState } from 'react';
import { ChatsModal, type ChatListItem } from '@/components/common/ChatsModal';
import { getChatListByUserId } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';

/**
 * Ports admin/Users/UserList/UserChatsModal.svelte: another user's chats,
 * searchable (half a second after the last keystroke), sortable, and loaded a
 * page at a time as the list is scrolled.
 */
export function UserChatsModal({
	open,
	onOpenChange,
	user
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	user: { id: string; name: string };
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [chatList, setChatList] = useState<ChatListItem[] | null>(null);
	const [query, setQuery] = useState('');
	const [orderBy, setOrderBy] = useState('updated_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [allChatsLoaded, setAllChatsLoaded] = useState(false);
	const [chatListLoading, setChatListLoading] = useState(false);
	const page = useRef(1);
	// Guards a slow response for an earlier query from overwriting a newer one.
	const generation = useRef(0);

	const filter = () => ({
		...(query ? { query } : {}),
		...(orderBy ? { order_by: orderBy } : {}),
		...(direction ? { direction } : {})
	});

	useEffect(() => {
		if (!open) {
			setChatList(null);
			setAllChatsLoaded(false);
			setChatListLoading(false);
			page.current = 1;
			return;
		}
		const mine = ++generation.current;
		page.current = 1;
		setChatList(null);
		const run = async () => {
			const list = ((await getChatListByUserId(token, user.id, 1, filter()).catch(() => null)) ?? []) as ChatListItem[];
			if (generation.current !== mine) return;
			setChatList(list);
			setAllChatsLoaded(list.length === 0);
		};
		if (query === '') {
			run();
			return;
		}
		const timer = setTimeout(run, 500);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, user.id, query, orderBy, direction, token]);

	const loadMore = async () => {
		setChatListLoading(true);
		const mine = generation.current;
		page.current += 1;
		const next = ((await getChatListByUserId(token, user.id, page.current, filter()).catch(() => [])) ?? []) as ChatListItem[];
		if (generation.current === mine) {
			setAllChatsLoaded(next.length === 0);
			if (next.length > 0) {
				setChatList((prev) => {
					const seen = new Set((prev ?? []).map((c) => c.id));
					return [...(prev ?? []), ...next.filter((c) => !seen.has(c.id))];
				});
			}
		}
		setChatListLoading(false);
	};

	return (
		<ChatsModal
			open={open}
			onOpenChange={onOpenChange}
			title={`${user.name.length > 32 ? `${user.name.slice(0, 32)}...` : user.name}'s Chats`}
			shareUrl
			query={query}
			onQueryChange={setQuery}
			orderBy={orderBy}
			direction={direction}
			onSortChange={(key, dir) => {
				setOrderBy(key);
				setDirection(dir);
			}}
			chatList={chatList}
			allChatsLoaded={allChatsLoaded}
			chatListLoading={chatListLoading}
			onDelete={(id) => setChatList((prev) => prev?.filter((c) => c.id !== id) ?? null)}
			loadHandler={loadMore}
		/>
	);
}
