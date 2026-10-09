import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
	addReaction,
	deleteMessage,
	getChannelMessages,
	getChannelThreadMessages,
	pinMessage,
	removeReaction,
	sendMessage,
	updateMessage
} from '@/lib/apis/channels';
import { useSocket } from '@/lib/socket/SocketProvider';
import { useAuthStore } from '@/lib/stores/authStore';
import {
	type ChannelEvent,
	type ChannelMessage,
	type ChannelUser,
	applyMessageEvent,
	applyTyping,
	closesThread,
	nowNs,
	toggleReaction
} from './channelModel';
import type { ComposerSubmit } from './MessageComposer';
import type { MessageActions } from './ChannelMessageView';

const PAGE = 50;
const TYPING_EXPIRES_MS = 5000;

/**
 * One list of messages, newest first: a channel's (`parentId` null) or a
 * thread's. Loads the first page, pages back on demand, follows the live
 * `events:channel` socket events for this list, tracks who is typing in it,
 * and provides the message actions, each applied optimistically and then sent
 * (Messages.svelte and Thread.svelte, which duplicated all of this between
 * them). `onPinChange` lets the channel mirror a pin made inside a thread.
 */
export function useMessageFeed(
	channelId: string,
	parentId: string | null,
	opts: { onRootDeleted?: () => void; onMessageDeleted?: (id: string) => void } = {}
) {
	const token = useAuthStore((s) => s.token) ?? '';
	const me = useAuthStore((s) => s.user);
	const { socket } = useSocket();
	const [messages, setMessages] = useState<ChannelMessage[] | null>(null);
	const [top, setTop] = useState(false);
	const [typing, setTyping] = useState<ChannelUser[]>([]);
	const loadingMore = useRef(false);
	const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	const optsRef = useRef(opts);
	optsRef.current = opts;
	/** Events that arrive while the first page loads, applied to it once it lands; null once loaded (docs/code-review.md L6). */
	const early = useRef<ChannelEvent[] | null>([]);

	const fetchPage = useCallback(
		(skip: number) =>
			(parentId
				? getChannelThreadMessages(token, channelId, parentId, skip, PAGE)
				: getChannelMessages(token, channelId, skip, PAGE)) as Promise<ChannelMessage[] | null>,
		[token, channelId, parentId]
	);

	useEffect(() => {
		let cancelled = false;
		setMessages(null);
		setTop(false);
		early.current = [];
		const scope = { channelId, parentId };
		const landed = (page: ChannelMessage[]) => {
			const pending = early.current ?? [];
			early.current = null;
			setMessages(pending.reduce((ms, e) => applyMessageEvent(ms, e, scope), page));
		};
		fetchPage(0)
			.then((page) => {
				if (cancelled) return;
				landed(page ?? []);
				setTop((page ?? []).length < PAGE);
			})
			.catch((e) => {
				if (cancelled) return;
				toast.error(`${e}`);
				landed([]);
				setTop(true);
			});
		return () => {
			cancelled = true;
		};
		// fetchPage changes with the channel and thread.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetchPage]);

	const loadMore = useCallback(async () => {
		if (loadingMore.current || top || !messages) return;
		loadingMore.current = true;
		const page = (await fetchPage(messages.length).catch(() => null)) ?? [];
		setMessages((ms) => [...(ms ?? []), ...page.filter((p) => !(ms ?? []).some((m) => m.id === p.id))]);
		if (page.length < PAGE) setTop(true);
		loadingMore.current = false;
	}, [fetchPage, messages, top]);

	useEffect(() => {
		if (!socket) return;
		const scope = { channelId, parentId };
		// Both rules return the same array for an event that is not about this
		// list, so React skips the re-render (a model's reply streams as a run of updates).
		const handler = (event: ChannelEvent) => {
			setTyping((t) => applyTyping(t, event, scope, me?.id));
			if (event.channel_id !== channelId) return;
			const type = event.data?.type ?? '';
			if (type === 'typing') {
				const who = event.user;
				// Not for the viewer's own typing, which the server echoes back; and
				// the same array when they are no longer listed (docs/code-review.md L8).
				if ((event.message_id ?? null) !== parentId || !who || who.id === me?.id) return;
				clearTimeout(typingTimers.current[who.id]);
				typingTimers.current[who.id] = setTimeout(
					() => setTyping((t) => (t.some((u) => u.id === who.id) ? t.filter((u) => u.id !== who.id) : t)),
					TYPING_EXPIRES_MS
				);
				return;
			}
			if (closesThread(event, scope)) optsRef.current.onRootDeleted?.();
			const id = event.data?.data?.id;
			if (type === 'message:delete' && id) optsRef.current.onMessageDeleted?.(id);
			if (early.current) early.current.push(event);
			else setMessages((ms) => (ms ? applyMessageEvent(ms, event, scope) : ms));
		};
		socket.on('events:channel', handler);
		return () => {
			socket.off('events:channel', handler);
		};
	}, [socket, channelId, parentId, me?.id]);

	useEffect(() => {
		const timers = typingTimers.current;
		return () => Object.values(timers).forEach(clearTimeout);
	}, []);

	const patch = (id: string, fn: (m: ChannelMessage) => ChannelMessage) =>
		setMessages((ms) => ms?.map((m) => (m.id === id ? fn(m) : m)) ?? ms);

	const emitTyping = () =>
		socket?.emit('events:channel', {
			channel_id: channelId,
			message_id: parentId,
			data: { type: 'typing', data: { typing: true } }
		});

	/**
	 * Sends a message. In the channel it shows at once as a pending copy
	 * (matched to the server's echo by `temp_id`); a thread waits for the echo,
	 * as Thread.svelte does.
	 */
	const submit = async ({ content, data }: ComposerSubmit, replyTo: ChannelMessage | null) => {
		const tempId = crypto.randomUUID();
		const form = {
			temp_id: tempId,
			content,
			data,
			reply_to_id: replyTo?.id ?? null,
			...(parentId ? { parent_id: parentId } : {})
		};
		if (!parentId) {
			const ts = nowNs();
			const optimistic: ChannelMessage = {
				id: tempId,
				temp_id: tempId,
				content,
				data,
				user_id: me?.id,
				user: me ? { id: me.id, name: me.name, role: me.role } : null,
				reply_to_message: replyTo,
				created_at: ts,
				updated_at: ts
			};
			setMessages((ms) => [optimistic, ...(ms ?? [])]);
		}
		const res = await sendMessage(token, channelId, form as never).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (!res && !parentId) setMessages((ms) => ms?.filter((m) => m.temp_id !== tempId) ?? ms);
		// The echo may beat the response or not arrive at all (no socket); either way end with the saved copy.
		// The response is the bare message (no author, quote or reactions), so those come from what
		// was sent until the echo brings the full copy (docs/code-review.md L5).
		if (res) {
			const saved = {
				...res,
				user: res.user ?? (me ? { id: me.id, name: me.name, role: me.role } : null),
				reply_to_message: res.reply_to_message ?? replyTo,
				reactions: res.reactions ?? [],
				temp_id: tempId
			};
			setMessages((ms) =>
				ms && !ms.some((m) => m.id === res.id)
					? applyMessageEvent(
							ms,
							{ channel_id: channelId, data: { type: 'message', data: saved } },
							{ channelId, parentId }
						)
					: ms
			);
		}
		return res;
	};

	const actions = (onPinChange?: (id: string, pinned: boolean) => void): MessageActions => ({
		onDelete: (m) => {
			setMessages((ms) => ms?.filter((x) => x.id !== m.id) ?? ms);
			// Deleting the root from inside its thread ends the thread, echo or not (docs/code-review.md L7).
			if (parentId && m.id === parentId) optsRef.current.onRootDeleted?.();
			optsRef.current.onMessageDeleted?.(m.id);
			deleteMessage(token, channelId, m.id).catch((e) => toast.error(`${e}`));
		},
		onEdit: (m, content) => {
			patch(m.id, (x) => ({ ...x, content }));
			updateMessage(token, channelId, m.id, { content } as never).catch((e) => toast.error(`${e}`));
		},
		onPin: (m) => {
			const pinned = !m.is_pinned;
			patch(m.id, (x) => ({
				...x,
				is_pinned: pinned,
				pinned_by: pinned ? (me?.id ?? null) : null,
				pinned_at: pinned ? nowNs() : null
			}));
			onPinChange?.(m.id, pinned);
			pinMessage(token, channelId, m.id, pinned).catch((e) => toast.error(`${e}`));
		},
		onReaction: (m, name) => {
			if (!me) return;
			const { message, added } = toggleReaction(m, name, { id: me.id, name: me.name });
			patch(m.id, () => message);
			(added ? addReaction : removeReaction)(token, channelId, m.id, name).catch((e) => toast.error(`${e}`));
		}
	});

	const setPinned = (id: string, pinned: boolean) =>
		patch(id, (x) => ({
			...x,
			is_pinned: pinned,
			pinned_by: pinned ? (me?.id ?? null) : null,
			pinned_at: pinned ? nowNs() : null
		}));

	return { messages, top, typing, loadMore, submit, emitTyping, actions, setPinned };
}
