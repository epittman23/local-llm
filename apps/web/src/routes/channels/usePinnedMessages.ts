import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getChannelPinnedMessages, pinMessage } from '@/lib/apis/channels';
import { useAuthStore } from '@/lib/stores/authStore';
import type { ChannelMessage } from './channelModel';

/** A message back in a list it was taken out of, at the place it had (or at the end). */
export function putBack(list: ChannelMessage[] | null, m: ChannelMessage, index: number) {
	if (!list || list.some((x) => x.id === m.id)) return list;
	const at = index < 0 ? list.length : Math.min(index, list.length);
	return [...list.slice(0, at), m, ...list.slice(at)];
}

/**
 * The pinned-messages dialog's list: paged as it scrolls, reloaded each time
 * the dialog opens, and an unpin that is shown at once and put back if the
 * server refuses it (#252). A first page that fails to load is `failed`, not
 * an empty list, so the dialog does not say there are no pinned messages.
 */
export function usePinnedMessages(
	channelId: string,
	open: boolean,
	onPinChange: (id: string, pinned: boolean) => void
) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [messages, setMessages] = useState<ChannelMessage[] | null>(null);
	const [done, setDone] = useState(false);
	const [failed, setFailed] = useState(false);
	const page = useRef(1);
	const loading = useRef(false);
	// load reads "done" from here, so it stays the same function between pages.
	const doneRef = useRef(false);

	const load = useCallback(
		async (reset = false) => {
			if (loading.current || (doneRef.current && !reset)) return;
			loading.current = true;
			if (reset) {
				page.current = 1;
				setFailed(false);
			}
			const res = (await getChannelPinnedMessages(token, channelId, page.current).catch((e) => {
				toast.error(`${e}`);
				return null;
			})) as ChannelMessage[] | null;
			if (res) {
				setMessages((ms) => [...(reset ? [] : (ms ?? [])), ...res]);
				doneRef.current = res.length === 0;
				setDone(doneRef.current);
				page.current += 1;
			} else if (reset) setFailed(true);
			loading.current = false;
		},
		[token, channelId]
	);

	// Each time the dialog opens, and for another channel, from the first page.
	useEffect(() => {
		if (!open) return;
		setMessages(null);
		doneRef.current = false;
		setDone(false);
		void load(true);
	}, [open, load]);

	const unpin = async (m: ChannelMessage) => {
		let index = -1;
		setMessages((ms) => {
			index = ms?.findIndex((x) => x.id === m.id) ?? -1;
			return ms?.filter((x) => x.id !== m.id) ?? ms;
		});
		onPinChange(m.id, false);
		await pinMessage(token, channelId, m.id, false).catch((e) => {
			// Refused: it is still pinned, so it goes back in its place.
			toast.error(`${e}`);
			setMessages((ms) => putBack(ms, m, index));
			onPinChange(m.id, true);
		});
	};

	return { messages, done, failed, load, unpin };
}
