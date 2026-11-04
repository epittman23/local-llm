import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { chatAction, getTaskIdsByChatId, stopTask, stopTasksByChatId } from '@/lib/apis';
import { deleteChatMessageById, getChatById, updateChatById } from '@/lib/apis/chats';
import { getAndUpdateUserLocation } from '@/lib/apis/users';
import { createNewFeedback, updateFeedbackById } from '@/lib/apis/evaluations';
import { generateTags } from '@/lib/apis';
import { type FeedbackDetails, annotate, feedbackItem } from '@/lib/chat/feedback';
import { generateOpenAIChatCompletion } from '@/lib/apis/openai';
import { WEBUI_BASE_URL } from '@/lib/constants';
import {
	type ChatEffect,
	type ChatEvent,
	type ChatFile,
	type History,
	type Message,
	addResponses,
	addUserMessage,
	applyChatEvent,
	deleteMessage,
	editContent,
	emptyHistory,
	errorText,
	failMessage,
	finishReplies,
	hasPendingAssistantLeaf,
	isGenerating,
	messagesList,
	normalizeHistory,
	saveReplyAsCopy,
	updateMessage
} from '@/lib/chat/history';
import {
	type FeatureToggles,
	completionBody,
	isTemporaryChatId,
	promptVariables,
	requestFeatures,
	temporaryChatId
} from '@/lib/chat/request';
import { getOutputText } from '@/lib/chat/structuredOutput';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useSocket } from '@/lib/socket/SocketProvider';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { copyToClipboard } from '@/lib/utils';
import { patchCachedChat } from './sidebar/useChatList';
import type { ChatModel } from './useModels';
import { uuid } from '@/lib/utils/uuid';

export const CHAT_LIST_KEY = ['chats'] as const;

export type ChatRecord = {
	id: string;
	title?: string;
	chat?: Record<string, any>;
	tags?: string[];
	pinned?: boolean;
	folder_id?: string | null;
	archived?: boolean;
	share_id?: string | null;
	current_message_id?: string | null;
	[k: string]: unknown;
};
export type ServerDialog = {
	type: 'confirmation' | 'input' | 'execute' | 'ask_user';
	data: any;
	reply: (value: unknown) => void;
};
/** `models`: the chat's models when it was queued, used even if another chat's are selected when it goes (#218). */
type Queued = { id: string; prompt: string; files: ChatFile[]; modelId?: string; models?: string[] };

/**
 * One open chat (Chat.svelte's state and its load/send/stream/stop cycle):
 *
 * - `chatId` is the route's, or the id the server assigned to a chat started
 *   here (the URL is then replaced, without reloading what is on screen).
 * - Sending adds the user message and an empty reply per model, then POSTs
 *   /api/chat/completions with this socket's session id; the reply streams
 *   back as `events` on the socket and goes through `applyChatEvent`.
 * - A prompt sent while a reply is still being written is queued (the
 *   user's "message queue" setting, on by default) and sent when it ends.
 */
/** One completion request: Stop sets `stopped`, `posted` once its POST is out; `settled` resolves once it is done with its tasks. */
type ChatRequest = { stopped: boolean; posted: boolean; settled: Promise<void>; settle: () => void };

export function useChatSession({
	routeChatId,
	folderId,
	models,
	selectedModels,
	temporary,
	toggles,
	toolIds
}: {
	routeChatId: string | null;
	folderId: string | null;
	models: ChatModel[];
	selectedModels: string[];
	temporary: boolean;
	toggles: FeatureToggles;
	toolIds: string[];
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const { settings } = useUserSettings();
	const { socket } = useSocket();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const [history, setHistoryState] = useState<History>(emptyHistory);
	const [chat, setChat] = useState<ChatRecord | null>(null);
	const [title, setTitle] = useState('');
	const [params, setParams] = useState<Record<string, any>>({});
	const [chatFiles, setChatFiles] = useState<ChatFile[]>([]);
	const [loading, setLoading] = useState(Boolean(routeChatId));
	const [taskIds, setTaskIds] = useState<string[] | null>(null);
	const [queue, setQueue] = useState<Queued[]>([]);
	const queueRef = useRef(queue);
	queueRef.current = queue;
	/** The queues of chats left with prompts still waiting, sent when that chat is open again (#218). */
	const leftQueues = useRef(new Map<string, Queued[]>());
	const [dialog, setDialogState] = useState<ServerDialog | null>(null);
	const dialogRef = useRef<ServerDialog | null>(null);
	const setDialog = useCallback((d: ServerDialog | null) => {
		dialogRef.current = d;
		setDialogState(d);
	}, []);

	const historyRef = useRef(history);
	const chatIdRef = useRef<string | null>(routeChatId);
	/** The chat this hook created and then moved the URL to: its route change must not reload it. */
	const adoptedRef = useRef<string | null>(null);
	/**
	 * Completion requests of the open chat not yet answered, each with its own
	 * stop flag. Stop pressed before the backend created a request's tasks
	 * cancels them as soon as that request learns of them, in a saved chat as
	 * in a new one (#151). One flag per request, so a later send cannot clear
	 * a stop meant for an earlier one (#516).
	 */
	const inFlightRef = useRef(new Set<ChatRequest>());
	const latest = useRef({
		params,
		chatFiles,
		settings,
		models,
		selectedModels,
		temporary,
		toggles,
		toolIds,
		folderId,
		queue
	});
	latest.current = {
		params,
		chatFiles,
		settings,
		models,
		selectedModels,
		temporary,
		toggles,
		toolIds,
		folderId,
		queue
	};

	const setHistory = useCallback((h: History | ((h: History) => History)) => {
		historyRef.current = typeof h === 'function' ? h(historyRef.current) : h;
		setHistoryState(historyRef.current);
	}, []);

	/** `{{USER_LOCATION}}` for the next request, when the user allowed it (Chat.svelte's getAndUpdateUserLocation). */
	const userLocation = useCallback(async (): Promise<string | undefined> => {
		if (!latest.current.settings?.userLocation) return undefined;
		return ((await getAndUpdateUserLocation(token).catch(() => null)) as string | null) ?? undefined;
	}, [token]);

	const refreshList = useCallback(() => queryClient.invalidateQueries({ queryKey: CHAT_LIST_KEY }), [queryClient]);

	const loadChat = useCallback(
		async (id: string) => {
			setLoading(true);
			const record = (await getChatById(token, id).catch(() => null)) as ChatRecord | null;
			if (chatIdRef.current !== id) return;
			if (!record?.chat) {
				// A queue given back to this chat cannot go anywhere now: drop it, saying
				// so, before `loading` ends and would let it into the chat still shown (#218).
				leftQueues.current.delete(id);
				if (queueRef.current.length) toast.error('The chat could not be opened; its queued prompts were dropped.');
				setQueue([]);
				setLoading(false);
				navigate('/', { replace: true });
				return;
			}
			const content = record.chat;
			let h = normalizeHistory(content.history, content.messages, record.current_message_id);
			// null when the task list could not be read: whether anything is running is unknown.
			const listed = ((await getTaskIdsByChatId(token, id).catch(() => null))?.task_ids ?? null) as string[] | null;
			const pending = listed ?? [];
			// Checked after every await: a slower load of the chat the user just
			// left must not overwrite the one now open (and later be saved into it).
			if (chatIdRef.current !== id) return;
			const current = h.currentId ? h.messages[h.currentId] : null;
			const complete = current?.role === 'assistant' && current.done;
			if (pending.length && !complete) setTaskIds(pending);
			else {
				setTaskIds(null);
				// Only with no task running is every unfinished reply really
				// finished; a multi-model sibling may outlive the current reply.
				if (listed && !listed.length) h = finishReplies(h);
				else if (current?.role === 'assistant' && !current.done) h = updateMessage(h, current.id, { done: true });
			}
			setChat(record);
			setTitle(content.title ?? record.title ?? '');
			const p = { ...(content.params ?? {}) };
			delete p.note_id;
			setParams(p);
			setChatFiles(content.files ?? []);
			setHistory(h);
			setLoading(false);
		},
		[token, navigate, setHistory]
	);

	// Opening, leaving, or finishing a reply in a saved chat marks it read (Chat.svelte's updateLastReadAt).
	const markRead = useCallback(
		(id: string | null) => {
			if (!id || isTemporaryChatId(id)) return;
			socket?.emit('events:chat', { chat_id: id, data: { type: 'last_read_at' } });
			patchCachedChat(queryClient, id, (c) => ({ ...c, last_read_at: Math.floor(Date.now() / 1000) + 1 }));
		},
		[socket, queryClient]
	);
	useEffect(() => {
		if (!routeChatId) return;
		markRead(routeChatId);
		return () => markRead(routeChatId);
	}, [routeChatId, markRead]);

	// The route decides which chat is open; a chat created here keeps its state across its own URL change.
	useEffect(() => {
		if (routeChatId && routeChatId === adoptedRef.current) return;
		adoptedRef.current = null;
		// The chat left keeps its queue; the one opened gets its own back (#218).
		const left = chatIdRef.current;
		// Not a temporary chat's: it is never opened again.
		if (left && !isTemporaryChatId(left) && queueRef.current.length) leftQueues.current.set(left, queueRef.current);
		const kept = routeChatId ? leftQueues.current.get(routeChatId) : undefined;
		if (routeChatId) leftQueues.current.delete(routeChatId);
		chatIdRef.current = routeChatId;
		// A stop in the chat opened now must not cancel the one left (#151).
		inFlightRef.current = new Set();
		setQueue(kept ?? []);
		setDialog(null);
		setTaskIds(null);
		if (routeChatId) void loadChat(routeChatId);
		else {
			setChat(null);
			setTitle('');
			setParams({});
			setChatFiles([]);
			setHistory(emptyHistory());
			setLoading(false);
		}
	}, [routeChatId, loadChat, setHistory, setDialog]);

	const handleEffects = useCallback(
		(effects: ChatEffect[], reply?: (v: unknown) => void) => {
			for (const e of effects) {
				switch (e.kind) {
					case 'done':
						if (latest.current.settings?.responseAutoCopy) void copyToClipboard(e.content);
						if (chatIdRef.current && !isTemporaryChatId(chatIdRef.current)) void refreshList();
						break;
					case 'error':
						toast.error(e.text);
						break;
					case 'title':
						setTitle(e.title);
						void refreshList();
						break;
					case 'tags':
						if (chatIdRef.current) {
							const id = chatIdRef.current;
							void getChatById(token, id).then((r) => r && chatIdRef.current === id && setChat(r));
						}
						break;
					case 'reload':
						if (chatIdRef.current) void loadChat(chatIdRef.current);
						break;
					case 'inactive': {
						setTaskIds(null);
						const id = chatIdRef.current;
						// No task left, yet a reply of this turn still reads as being
						// written: its done event was missed (a dropped socket, a backend
						// reload). The stored chat has its real end (#214). Not while a
						// request of ours is unanswered: its reply is not stored yet.
						if (
							id &&
							!isTemporaryChatId(id) &&
							!inFlightRef.current.size &&
							hasPendingAssistantLeaf(historyRef.current, e.messageId)
						)
							void loadChat(id);
						markRead(id);
						break;
					}
					case 'cancelled':
						// A reply a later send replaced was cancelled (a stop that
						// landed before its task existed): the tasks shown are
						// that later send's, still running (#516).
						if (e.current) setTaskIds(null);
						break;
					case 'notification':
						(
							({ success: toast.success, error: toast.error, warning: toast.warning }) as Record<
								string,
								(m: string) => void
							>
						)[e.level]?.(e.content) ?? toast.info(e.content);
						break;
					case 'dialog': {
						const next: ServerDialog = { type: e.type, data: e.data, reply: (v) => reply?.(v) };
						// One dialog at a time: a newer one dismisses the one still open,
						// answering it as a cancel so its server-side call isn't left
						// waiting for its own timeout.
						const prev = dialogRef.current;
						if (prev) prev.reply(prev.type === 'ask_user' ? { status: 'cancelled', answers: {} } : false);
						dialogRef.current = next;
						setDialog(next);
						break;
					}
				}
			}
		},
		[token, loadChat, refreshList, markRead, setDialog]
	);

	useEffect(() => {
		if (!socket) return;
		const handler = (event: ChatEvent, reply?: (v: unknown) => void) => {
			const current = chatIdRef.current;
			// A chat started here has no id until the POST returns; its events are recognised by message id.
			const ours =
				event.chat_id === current ||
				(!current && Boolean(event.message_id && historyRef.current.messages[event.message_id]));
			if (!ours) return;
			const { history: next, effects } = applyChatEvent(historyRef.current, event);
			if (next !== historyRef.current) setHistory(next);
			handleEffects(effects, reply);
		};
		socket.on('events', handler);
		return () => {
			socket.off('events', handler);
		};
	}, [socket, setHistory, handleEffects]);

	// Events sent while the socket was down are lost. On reconnect, a reply
	// still being written whose chat has no task left missed its end, so the
	// stored chat is loaded again (#214), as Chat.svelte's handleSocketConnect did.
	useEffect(() => {
		if (!socket) return;
		const idle = () => !inFlightRef.current.size;
		const onConnect = async () => {
			const id = chatIdRef.current;
			if (!id || isTemporaryChatId(id) || !idle() || !hasPendingAssistantLeaf(historyRef.current)) return;
			const res = await getTaskIdsByChatId(token, id).catch(() => null);
			// Checked again after the wait: a send made meanwhile has no task yet.
			if (res && !(res.task_ids ?? []).length && chatIdRef.current === id && idle()) void loadChat(id);
		};
		socket.on('connect', onConnect);
		// Already connected when this listener attached (the provider exposes
		// the socket only after its first connect): check once now.
		if (socket.connected) void onConnect();
		return () => {
			socket.off('connect', onConnect);
		};
	}, [socket, token, loadChat]);

	/**
	 * Registers a completion request, so Stop marks it from now on, while its
	 * body is still being built as well as while its POST is out. Then waits
	 * for any request of this chat that was stopped before it learned its
	 * tasks: that one cancels them by chat id, which would also take this
	 * request's reply if it were already running (#516).
	 */
	const beginRequest = useCallback(async (): Promise<ChatRequest | null> => {
		let settle = () => {};
		const settled = new Promise<void>((resolve) => (settle = resolve));
		const req: ChatRequest = { stopped: false, posted: false, settled, settle };
		const requests = inFlightRef.current;
		// Only one that posted can have tasks to cancel; one stopped while its
		// body was built never posts, so it is not waited for.
		const earlier = [...requests].filter((r) => r.stopped && r.posted);
		requests.add(req);
		await Promise.all(earlier.map((r) => r.settled));
		// Another chat opened while this one waited: the history and chat id
		// to send with are gone, so nothing is sent. (A chat left and opened
		// again within that wait starts a new set, so the order is not kept
		// across that round trip; the window is one unanswered POST.)
		if (inFlightRef.current !== requests) {
			requests.delete(req);
			settle();
			toast.error('The chat changed before the message could be sent.');
			return null;
		}
		return req;
	}, []);

	const endRequest = useCallback((req: ChatRequest) => {
		inFlightRef.current.delete(req);
		req.settle();
	}, []);

	/**
	 * Cancels the tasks of a request stopped before it learned them. By chat
	 * id where there is one: the chat's owner may stop those, while stopping
	 * a task by its own id is for admins only.
	 */
	const cancelStopped = useCallback(
		async (chatId: string | null | undefined, ids: string[]) => {
			if (chatId) await stopTasksByChatId(token, chatId).catch((e) => toast.error(`${e}`));
			else for (const t of ids) await stopTask(token, t).catch((e) => toast.error(`${e}`));
		},
		[token]
	);

	/** Asks for a reply (or one per selected model) to the user message `parentId`. */
	const requestReply = useCallback(
		async (
			parentId: string,
			opts: {
				modelId?: string;
				/** The models to answer, when not the ones selected now (a queued prompt, #218). */
				models?: string[];
				modelIdx?: number;
				regenerationPrompt?: string | null;
				messages?: Message[] | null;
			} = {}
		) => {
			const l = latest.current;
			const ids = opts.modelId ? [opts.modelId] : (opts.models ?? l.selectedModels);
			const chosen = ids.map((id) => l.models.find((m) => m.id === id)).filter((m): m is ChatModel => Boolean(m));
			if (!chosen.length) {
				toast.error('Model not selected');
				return;
			}
			if (!opts.modelId) setHistory((h) => updateMessage(h, parentId, { models: ids }));
			const { history: h, targets } = addResponses(historyRef.current, parentId, chosen, opts.modelIdx);
			setHistory(h);

			const primary = targets[0];
			const req = await beginRequest();
			if (!req) return;
			// Read after the wait: a new chat's earlier request may have created the chat meanwhile.
			let chatId = chatIdRef.current;
			if (!chatId && l.temporary) chatId = chatIdRef.current = temporaryChatId(socket?.id);
			const usage = setInterval(
				() => socket?.emit('usage', { action: 'chat', model: primary.model_id, chat_id: chatId ?? '' }),
				1000
			);
			try {
				const body = completionBody({
					history: historyRef.current,
					responseId: primary.message_id,
					targets,
					model: chosen[0],
					chatId,
					temporary: l.temporary || isTemporaryChatId(chatId),
					sessionId: socket?.id,
					folderId: l.folderId,
					params: l.params,
					settings: l.settings,
					chatFiles: l.chatFiles,
					features: requestFeatures(l.toggles, user, config, l.settings),
					toolIds: l.toolIds,
					variables: promptVariables(user, await userLocation()),
					regenerationPrompt: opts.regenerationPrompt,
					messages: opts.messages
				});
				// Stopped while the body was built (it awaits the user's location): never sent.
				if (req.stopped) return;
				req.posted = true;
				const res = await generateOpenAIChatCompletion(token, body, `${WEBUI_BASE_URL}/api`).catch((error) => {
					toast.error(errorText(error) || 'Uh-oh! There was an issue with the response.');
					setHistory((cur) => updateMessage(cur, primary.message_id, (m) => failMessage(m, error)));
					return null;
				});
				if (!res) return;
				if (res.error) {
					toast.error(errorText(res.error));
					setHistory((cur) => updateMessage(cur, primary.message_id, (m) => failMessage(m, res.error)));
					return;
				}
				const ids: string[] = res.task_ids ?? (res.task_id ? [res.task_id] : []);
				if (req.stopped) await cancelStopped(res.chat_id ?? chatId, ids);
				else setTaskIds(ids.length ? ids : null);
				if (res.chat_id && !chatIdRef.current && !l.temporary) {
					chatIdRef.current = adoptedRef.current = res.chat_id;
					navigate(`/c/${res.chat_id}`, { replace: true });
					void refreshList();
					if (Object.keys(l.params).length) void updateChatById(token, res.chat_id, { params: l.params });
				}
			} finally {
				clearInterval(usage);
				endRequest(req);
			}
		},
		[
			socket,
			token,
			user,
			config,
			navigate,
			refreshList,
			setHistory,
			userLocation,
			beginRequest,
			endRequest,
			cancelStopped
		]
	);

	const send = useCallback(
		/** `queued`: the prompt waited behind a reply, so goes even if that reply failed (#213). */
		async (prompt: string, files: ChatFile[] = [], modelId?: string, queued = false, models?: string[]) => {
			const h = historyRef.current;
			const current = h.currentId ? h.messages[h.currentId] : null;
			if (!queued && current?.error && !current.content) {
				toast.error('Oops! There was an error in the previous response.');
				return;
			}
			const docs = files.filter(
				(f) =>
					['doc', 'text', 'note', 'chat', 'folder', 'collection'].includes(f.type ?? '') ||
					(f.type === 'file' && !(f.content_type ?? '').startsWith('image/'))
			);
			if (docs.length)
				setChatFiles((cf) =>
					[...cf, ...docs].filter((f, i, a) => a.findIndex((g) => JSON.stringify(g) === JSON.stringify(f)) === i)
				);
			latest.current.chatFiles = [...latest.current.chatFiles, ...docs];
			const { history: next, id } = addUserMessage(h, h.currentId, {
				content: prompt,
				files,
				models: modelId ? [modelId] : (models ?? latest.current.selectedModels)
			});
			setHistory(next);
			await requestReply(id, modelId ? { modelId } : { models });
		},
		[requestReply, setHistory]
	);

	const stop = useCallback(async () => {
		const id = chatIdRef.current;
		// A request whose POST hasn't answered has no task to cancel yet, in a
		// saved chat as in a new one: it cancels its tasks once it learns them.
		for (const req of inFlightRef.current) req.stopped = true;
		if (id) await stopTasksByChatId(token, id).catch((e) => toast.error(`${e}`));
		else if (taskIds?.length) for (const t of taskIds) await stopTask(token, t).catch((e) => toast.error(`${e}`));
		setTaskIds(null);
		setHistory((h) => {
			const m = h.currentId ? h.messages[h.currentId] : null;
			if (!m?.parentId) return h;
			let next = h;
			for (const c of h.messages[m.parentId]?.childrenIds ?? []) next = updateMessage(next, c, { done: true });
			return next;
		});
	}, [token, taskIds, setHistory]);

	/** The input's submit: validated, then sent now or queued behind the reply being written. */
	const submit = useCallback(
		/** `modelId`: a model picked with `@` answers just this message. */
		(prompt: string, files: ChatFile[] = [], modelId?: string) => {
			const l = latest.current;
			if (!prompt.trim() && !files.length) {
				toast.error('Please enter a prompt');
				return false;
			}
			if (!modelId && (!l.selectedModels.length || l.selectedModels.includes(''))) {
				toast.error('Model not selected');
				return false;
			}
			const maxCount = (config as { file?: { max_count?: number | null } } | null)?.file?.max_count ?? null;
			if (maxCount !== null && files.length + l.chatFiles.length > maxCount) {
				toast.error(`You can only chat with a maximum of ${maxCount} file(s) at a time.`);
				return false;
			}
			if (isGenerating(historyRef.current)) {
				if (l.settings?.enableMessageQueue ?? true) {
					setQueue((q) => [...q, { id: uuid(), prompt, files, modelId, models: l.selectedModels }]);
					return true;
				}
				// Queue off: interrupt the reply being written, as the setting
				// says, rather than stream a second reply beside it (#212).
				const chatId = chatIdRef.current;
				void stop().then(() => {
					// Another chat opened while stopping: this prompt was for the old one.
					if (chatIdRef.current === chatId) void send(prompt, files, modelId);
					else toast.error('The chat changed before the message could be sent.');
				});
				return true;
			}
			void send(prompt, files, modelId);
			return true;
		},
		[config, send, stop]
	);

	// When the reply finishes, the next queued prompt goes.
	const generating = isGenerating(history);
	useEffect(() => {
		// Not before the chat has loaded: a queue given back on returning to a
		// chat would otherwise go into the history still shown (#218).
		if (generating || loading || !queue.length) return;
		const [next, ...rest] = queue;
		setQueue(rest);
		// Already taken off the queue, so it must not be refused for the reply
		// it waited on failing; the prompt and its files were lost (#213).
		void send(next.prompt, next.files, next.modelId, true, next.models);
	}, [generating, loading, queue, send]);

	const regenerate = useCallback(
		async (message: Message, suggestionPrompt?: string) => {
			const userMessage = message.parentId ? historyRef.current.messages[message.parentId] : null;
			if (!userMessage) {
				toast.error('Parent message not found');
				return;
			}
			const multi = (userMessage.models ?? latest.current.selectedModels).length > 1;
			await requestReply(userMessage.id, {
				...(suggestionPrompt
					? { messages: messagesList(historyRef.current, message.id), regenerationPrompt: suggestionPrompt }
					: {}),
				...(multi ? { modelId: message.model, modelIdx: message.modelIdx } : {})
			});
		},
		[requestReply]
	);

	/** Saves the history (edits, deletions, branch changes) for a saved chat. */
	const save = useCallback(
		async (h: History = historyRef.current) => {
			const id = chatIdRef.current;
			if (!id || isTemporaryChatId(id)) return;
			const res = await updateChatById(token, id, {
				models: latest.current.selectedModels,
				history: h,
				messages: messagesList(h, h.currentId),
				params: latest.current.params,
				files: latest.current.chatFiles
			}).catch((e) => {
				toast.error(`${e}`);
				return null;
			});
			if (res) setChat(res as ChatRecord);
		},
		[token]
	);

	/** Continues a finished reply from where it stopped (the server appends to it). */
	const continueReply = useCallback(
		async (message: Message) => {
			const l = latest.current;
			const model = l.models.find((m) => m.id === (message.selectedModelId ?? message.model));
			if (!model) {
				toast.error('Model not found');
				return;
			}
			setHistory((h) => updateMessage(h, message.id, { done: false }));
			const req = await beginRequest();
			if (!req) return;
			const chatId = chatIdRef.current;
			try {
				const body = completionBody({
					history: historyRef.current,
					responseId: message.id,
					model,
					chatId,
					temporary: isTemporaryChatId(chatId),
					sessionId: socket?.id,
					folderId: l.folderId,
					params: l.params,
					settings: l.settings,
					chatFiles: l.chatFiles,
					features: requestFeatures(l.toggles, user, config, l.settings),
					toolIds: l.toolIds,
					variables: promptVariables(user, await userLocation()),
					continueResponse: true
				});
				if (req.stopped) return;
				req.posted = true;
				const res = await generateOpenAIChatCompletion(token, body, `${WEBUI_BASE_URL}/api`).catch((error) => {
					toast.error(errorText(error));
					setHistory((cur) => updateMessage(cur, message.id, (m) => failMessage(m, error)));
					return null;
				});
				if (res?.error) {
					toast.error(errorText(res.error));
					setHistory((cur) => updateMessage(cur, message.id, (m) => failMessage(m, res.error)));
					return;
				}
				const ids: string[] = res?.task_ids ?? (res?.task_id ? [res.task_id] : []);
				if (req.stopped) await cancelStopped(chatId, ids);
				else if (ids.length) setTaskIds(ids);
			} finally {
				endRequest(req);
			}
		},
		[socket, token, user, config, setHistory, userLocation, beginRequest, endRequest, cancelStopped]
	);

	/** Edits a prompt and sends it again as a new branch (`resend`), or edits a message in place. */
	const editMessage = useCallback(
		async (message: Message, content: string, mode: 'save' | 'resend' | 'copy') => {
			const h = historyRef.current;
			if (mode === 'resend') {
				const { history: next, id } = addUserMessage(h, message.parentId, {
					content,
					files: message.files,
					models: latest.current.selectedModels
				});
				setHistory(next);
				await requestReply(id);
				return;
			}
			const next = mode === 'copy' ? saveReplyAsCopy(h, message.id, content) : editContent(h, message.id, content);
			setHistory(next);
			await save(next);
		},
		[requestReply, save, setHistory]
	);

	/** Deletes a message (and its replies): on the server for a saved chat, which answers with the new history. */
	const removeMessage = useCallback(
		async (message: Message) => {
			const id = chatIdRef.current;
			if (id && !isTemporaryChatId(id)) {
				const res = (await deleteChatMessageById(token, id, message.id).catch((e) => {
					toast.error(`${e}`);
					return null;
				})) as { chat?: { history?: History } } | null;
				// The server's copy still has replies this load finished; with
				// nothing generating, finish them again (#150). Not if another
				// chat opened meanwhile: its view would take this one's history.
				if (res?.chat?.history && chatIdRef.current === id) {
					const h = normalizeHistory(res.chat.history);
					setHistory(taskIds ? h : finishReplies(h));
				}
				void refreshList();
			} else setHistory((h) => deleteMessage(h, message.id));
		},
		[token, refreshList, setHistory, taskIds]
	);

	/**
	 * Runs one of the reply's model Action functions (Chat.svelte's
	 * chatActionHandler): the server gets the conversation up to the reply,
	 * and any messages it sends back replace theirs, keeping the old text as
	 * `originalContent`; a saved chat is then saved. What the action streams
	 * meanwhile arrives as ordinary socket events.
	 */
	const runAction = useCallback(
		async (actionId: string, message: Message) => {
			const chatId = chatIdRef.current;
			const list = messagesList(historyRef.current, message.id);
			const res = (await chatAction(token, actionId, {
				model: message.model ?? '',
				messages: list.map((m) => ({
					id: m.id,
					role: m.role,
					content: getOutputText(m.output) || m.content,
					info: m.info,
					timestamp: m.timestamp,
					...(m.sources ? { sources: m.sources } : {})
				})),
				model_item: latest.current.models.find((m) => m.id === message.model),
				chat_id: chatId,
				session_id: socket?.id,
				id: message.id
			}).catch((e) => {
				toast.error(`${e}`);
				return null;
			})) as { messages?: Partial<Message>[] } | null;
			// Another chat opened meanwhile: its history must not take these
			// messages, nor be saved into this one's record (#215).
			if (!res?.messages?.length || chatIdRef.current !== chatId) return;
			let h = historyRef.current;
			for (const m of res.messages) {
				const cur = m.id ? h.messages[m.id] : undefined;
				if (cur)
					h = updateMessage(h, cur.id, {
						...(m.content !== undefined && m.content !== cur.content ? { originalContent: cur.content } : {}),
						...m
					});
			}
			setHistory(h);
			await save(h);
		},
		[token, socket, save, setHistory]
	);

	/**
	 * Rates a reply, or adds details to its rating, and records it as feedback
	 * (creating it the first time). After a first thumbs up or down with no
	 * tags yet, asks the model for tags, as the Svelte app does.
	 */
	const rate = useCallback(
		async (message: Message, rating: number | null, details: FeedbackDetails | null = null) => {
			const id = chatIdRef.current;
			if (!id || isTemporaryChatId(id)) return;
			// This chat's history as it is now: the awaits below may end in another chat.
			const history = historyRef.current;
			const annotation = annotate(message, rating, details);
			const chatRecord = await getChatById(token, id).catch((e) => {
				toast.error(`${e}`);
				return null;
			});
			if (!chatRecord) return;
			const baseModelOf = (mid: string) => {
				const m = latest.current.models.find((x) => x.id === mid);
				return m ? (m.info?.base_model_id ?? null) : undefined;
			};
			const item = feedbackItem({
				history,
				message,
				annotation,
				chatId: id,
				chat: chatRecord,
				baseModelOf
			});
			const feedbackId = message.feedbackId as string | undefined;
			const res = (await (feedbackId
				? updateFeedbackById(token, feedbackId, item)
				: createNewFeedback(token, item)
			).catch((e) => {
				toast.error(`${e}`);
				return null;
			})) as { id?: string } | null;
			const patch = { annotation, ...(res?.id && !feedbackId ? { feedbackId: res.id } : {}) };
			// Another chat opened meanwhile: record the rating in this chat's
			// stored copy, not in the chat now open (#215).
			if (chatIdRef.current !== id) {
				const stored = chatRecord.chat?.history as History | undefined;
				if (stored?.messages?.[message.id]) {
					const h = updateMessage(stored, message.id, patch);
					await updateChatById(token, id, {
						...chatRecord.chat,
						history: h,
						messages: messagesList(h, h.currentId)
					}).catch((e) => toast.error(`${e}`));
				}
				return;
			}
			const next = updateMessage(historyRef.current, message.id, patch);
			setHistory(next);
			await save(next);
			if (!details && !(annotation as { tags?: string[] }).tags && message.content) {
				const tags = (await generateTags(token, message.model ?? '', messagesList(next, message.id) as never, id).catch(
					() => null
				)) as string[] | null;
				const fid = (next.messages[message.id].feedbackId as string | undefined) ?? res?.id;
				if (tags?.length && fid) {
					if (chatIdRef.current === id) {
						const tagged = updateMessage(historyRef.current, message.id, (m) => ({
							annotation: { ...(m.annotation ?? {}), tags }
						}));
						setHistory(tagged);
						void save(tagged);
					}
					void updateFeedbackById(token, fid, { ...item, data: { ...item.data, tags } }).catch(() => {});
				}
			}
		},
		[token, save, setHistory]
	);

	return {
		continueReply,
		editMessage,
		removeMessage,
		rate,
		runAction,
		chatId: chatIdRef.current,
		/** The id the server gave a chat started on this page (its URL change is not a new chat). */
		adoptedChatId: adoptedRef.current,
		chat,
		setChat,
		title,
		history,
		setHistory,
		params,
		setParams,
		chatFiles,
		setChatFiles,
		loading,
		generating,
		taskIds,
		queue,
		removeQueued: (id: string) => setQueue((q) => q.filter((x) => x.id !== id)),
		dialog,
		closeDialog: () => setDialog(null),
		submit,
		stop,
		regenerate,
		requestReply,
		save,
		reload: () => chatIdRef.current && loadChat(chatIdRef.current)
	};
}
