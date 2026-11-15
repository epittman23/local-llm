import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { toggleChatPinnedStatusById } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { usePinnedChats } from './useChatList';

/**
 * Whether a chat is pinned, and Pin/Unpin for it: the sidebar row's menu and
 * the chat page's menu share it. Chat list items carry no `pinned`; the pinned
 * list says which are (#948). Toggling toasts the outcome and refreshes the
 * chat lists.
 */
export function usePinChat(chatId: string) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const pinnedList = usePinnedChats().data;
	const pinned = useMemo(() => (pinnedList ?? []).some((c) => c.id === chatId), [pinnedList, chatId]);
	const toggle = async () => {
		try {
			await toggleChatPinnedStatusById(token, chatId);
			toast.success(pinned ? 'Chat unpinned' : 'Chat pinned');
		} catch (e) {
			toast.error(`${e}`);
		}
		void queryClient.invalidateQueries({ queryKey: ['chats'] });
	};
	return { pinned, toggle };
}
