import { useEffect, useRef } from 'react';

/**
 * Runs `reset` when the open chat changes: another chat, or a new one. Not when
 * a chat started on this page takes on its id (`adoptedChatId`), which is the
 * same chat getting its URL (#217).
 */
export function useOnChatSwitch(chatId: string | null | undefined, adoptedChatId: string | null, reset: () => void) {
	const shown = useRef(chatId);
	const latestReset = useRef(reset);
	latestReset.current = reset;
	useEffect(() => {
		if (shown.current === chatId) return;
		shown.current = chatId;
		if (chatId && chatId === adoptedChatId) return;
		latestReset.current();
	}, [chatId, adoptedChatId]);
}
