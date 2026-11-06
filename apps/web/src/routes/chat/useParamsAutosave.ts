import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { updateChatById } from '@/lib/apis/chats';
import { useDebouncedCallback } from '@/lib/utils/useDebouncedCallback';

/**
 * Saves a saved chat's Chat Controls params after a 500 ms pause, and returns
 * the function the controls call with each edit. The chat's id goes with each
 * pending save, so it always lands in the chat it was edited in. A pending save
 * is made at once when the page unmounts, so leaving the page does not drop it
 * (#525), and when another chat opens, so going back to the chat straight away
 * loads the saved params. A new chat (no id) saves nothing here: its params go
 * with its first message.
 */
export function useParamsAutosave(chatId: string | null | undefined, token: string) {
	const save = useDebouncedCallback(
		({ id, params }: { id: string; params: Record<string, unknown> }) =>
			updateChatById(token, id, { params }).catch((e) => toast.error(`${e}`)),
		500
	);
	useEffect(() => {
		if (!chatId) return;
		return save.flush;
	}, [chatId, save]);
	return useCallback(
		(params: Record<string, unknown>) => {
			if (chatId) save({ id: chatId, params });
		},
		[chatId, save]
	);
}
