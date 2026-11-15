import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { resolveChatMessageToolCall } from '@/lib/apis/chats';
import { type History, pendingAskUser } from '@/lib/chat/history';
import { isTemporaryChatId } from '@/lib/chat/request';
import type { ServerDialog } from './useChatSession';

/**
 * The ask_user question a stored reply is waiting on, as a dialog (Chat.svelte's
 * savedAskUserPrompt). Submitting answers the call and Skip rejects it, both
 * through the resolve endpoint, which resumes the reply; `onResolved` then
 * loads the chat again. It has no time limit: the reply stays paused until the
 * question is answered, however long that takes.
 */
export function useSavedAskUser({
	history,
	chatId,
	token,
	onResolved
}: {
	history: History;
	chatId: string | null;
	token: string;
	onResolved: () => void;
}): { dialog: ServerDialog | null; close: () => void } {
	const pending = useMemo(() => pendingAskUser(history), [history]);
	// The call last answered or skipped here, hidden until the reload shows its result.
	const [handled, setHandled] = useState<string | null>(null);
	// Read when the user replies, so a new token or callback does not make a new
	// dialog: ServerDialogs keys the dialog by identity, and a new one would
	// drop the answers picked so far.
	const latest = useRef({ token, onResolved });
	latest.current = { token, onResolved };

	const messageId = pending?.messageId;
	const callId = pending?.callId;
	// By value: every history update parses the arguments into new arrays.
	const args = pending ? JSON.stringify({ questions: pending.questions, allow_other: pending.allowOther }) : '';
	const saved = Boolean(chatId) && !isTemporaryChatId(chatId ?? '');

	const dialog = useMemo<ServerDialog | null>(() => {
		if (!messageId || !callId || !args || !saved || !chatId || callId === handled) return null;
		return {
			type: 'ask_user',
			data: JSON.parse(args),
			reply: (value) => {
				setHandled(callId);
				const { token: t, onResolved: done } = latest.current;
				const v = (value ?? {}) as { status?: string; answers?: unknown };
				const resolved =
					v.status === 'answered'
						? resolveChatMessageToolCall(t, chatId, messageId, callId, 'answer', { answers: v.answers ?? {} })
						: resolveChatMessageToolCall(t, chatId, messageId, callId, 'reject');
				resolved.then(done).catch((e) => {
					toast.error(String(e));
					setHandled(null);
					done();
				});
			}
		};
	}, [messageId, callId, args, saved, chatId, handled]);

	return { dialog, close: () => callId && setHandled(callId) };
}
