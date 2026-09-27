import { processDetails } from '@/lib/markdown/content';
import { type OutputItem, applyResponseStreamEvent, getOutputText } from './structuredOutput';

// A chat is a tree of messages (edits and regenerations are siblings), and
// `currentId` is the leaf being shown. Everything here is pure: each function
// returns a new history and never mutates the one it was given, so React sees
// every change. Ported from Chat.svelte, which mutated in place.

export type ChatFile = { type?: string; id?: string | null; url?: string; name?: string; content_type?: string; status?: string; size?: number; [k: string]: unknown };
export type Source = { source?: { id?: string; name?: string; url?: string; [k: string]: unknown }; document?: string[]; metadata?: Record<string, unknown>[]; [k: string]: unknown };
export type Status = { action?: string; description?: string; done?: boolean; hidden?: boolean; [k: string]: unknown };

export type Message = {
	id: string;
	parentId: string | null;
	childrenIds: string[];
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp?: number;
	done?: boolean;
	model?: string;
	modelName?: string;
	modelIdx?: number;
	models?: string[];
	files?: ChatFile[];
	error?: { content?: unknown } | null;
	output?: OutputItem[];
	sources?: Source[];
	statusHistory?: Status[];
	usage?: Record<string, unknown>;
	followUps?: string[];
	code_executions?: { id: string; [k: string]: unknown }[];
	embeds?: unknown[];
	selectedModelId?: string;
	arena?: boolean;
	favorite?: boolean;
	originalContent?: string;
	annotation?: Record<string, unknown>;
	[k: string]: unknown;
};
export type History = { messages: Record<string, Message>; currentId: string | null };

export const emptyHistory = (): History => ({ messages: {}, currentId: null });
const now = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

/** The path from the root to `id`, oldest first. */
export function messagesList(history: History, id: string | null | undefined): Message[] {
	const list: Message[] = [];
	const seen = new Set<string>();
	let current = id ?? null;
	while (current && history.messages[current] && !seen.has(current)) {
		seen.add(current);
		list.push(history.messages[current]);
		current = history.messages[current].parentId;
	}
	return list.reverse();
}

export function updateMessage(history: History, id: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)): History {
	const m = history.messages[id];
	if (!m) return history;
	const next = typeof patch === 'function' ? patch(m) : patch;
	return { ...history, messages: { ...history.messages, [id]: { ...m, ...next } } };
}

/** Adds `message` under its parent and makes it current. */
function attach(history: History, message: Message): History {
	const messages = { ...history.messages, [message.id]: message };
	const parent = message.parentId ? messages[message.parentId] : null;
	if (parent) messages[parent.id] = { ...parent, childrenIds: [...parent.childrenIds, message.id] };
	return { messages, currentId: message.id };
}

export function addUserMessage(history: History, parentId: string | null, fields: { content: string; files?: ChatFile[]; models?: string[] }): { history: History; id: string } {
	const id = uuid();
	const message: Message = { id, parentId, childrenIds: [], role: 'user', content: fields.content, files: fields.files?.length ? fields.files : undefined, models: fields.models, timestamp: now() };
	return { history: attach(history, message), id };
}

export type ModelRef = { id: string; name?: string };
export type ResponseTarget = { model_id: string; message_id: string; modelIdx: number };

/**
 * Adds an empty, not-done assistant reply for each model under `parentId`;
 * the last one becomes current. `modelIdx` pins a regenerated reply to its
 * column in a side-by-side chat.
 */
export function addResponses(history: History, parentId: string, models: ModelRef[], modelIdx?: number): { history: History; targets: ResponseTarget[] } {
	let h = history;
	const targets: ResponseTarget[] = [];
	models.forEach((model, i) => {
		const idx = modelIdx ?? i;
		const id = uuid();
		h = attach(h, { id, parentId, childrenIds: [], role: 'assistant', content: '', done: false, model: model.id, modelName: model.name ?? model.id, modelIdx: idx, timestamp: now() });
		targets.push({ model_id: model.id, message_id: id, modelIdx: idx });
	});
	return { history: h, targets };
}

/** The ids at the same level as `message`: its parent's children, or the root messages. */
export function siblingsOf(history: History, message: Message): string[] {
	if (message.parentId) return history.messages[message.parentId]?.childrenIds ?? [message.id];
	return Object.values(history.messages)
		.filter((m) => m.parentId === null)
		.map((m) => m.id);
}

/** Shows `id` and, below it, the most recent branch at each level. */
export function showBranch(history: History, id: string): History {
	let current = id;
	const seen = new Set<string>();
	while (history.messages[current]?.childrenIds.length && !seen.has(current)) {
		seen.add(current);
		current = history.messages[current].childrenIds.at(-1)!;
	}
	return { ...history, currentId: current };
}

/**
 * Repairs a history read from the server (Chat.svelte's sanitizeHistory and
 * loadChat): drops junk entries, restores missing ids/children/parents/roles,
 * falls back to the newest leaf when `currentId` is broken, and marks every
 * assistant reply but the current one done.
 */
export function normalizeHistory(raw: Partial<History> | null | undefined, messages?: Partial<Message>[], currentMessageId?: string | null): History {
	let history: History;
	if (raw?.messages && typeof raw.messages === 'object') history = { messages: { ...raw.messages }, currentId: raw.currentId ?? null };
	else {
		history = emptyHistory();
		let parent: string | null = null;
		for (const m of messages ?? []) {
			const id: string = (m.id as string) ?? uuid();
			history.messages[id] = { ...(m as Message), id, parentId: (m.parentId as string | null) ?? parent, childrenIds: [] };
			parent = id;
		}
		for (const m of Object.values(history.messages)) if (m.parentId && history.messages[m.parentId]) history.messages[m.parentId].childrenIds.push(m.id);
		history.currentId = parent;
	}
	const msgs: Record<string, Message> = {};
	for (const [id, m] of Object.entries(history.messages)) {
		if (!m || typeof m !== 'object') continue;
		msgs[id] = { ...m, id, childrenIds: Array.isArray(m.childrenIds) ? [...m.childrenIds] : [], content: typeof m.content === 'string' ? m.content : String(m.content ?? '') };
	}
	const parentOf: Record<string, string> = {};
	for (const [id, m] of Object.entries(msgs)) for (const c of m.childrenIds) parentOf[c] = id;
	for (const m of Object.values(msgs)) m.childrenIds = m.childrenIds.filter((c) => msgs[c]);

	let currentId = currentMessageId && msgs[currentMessageId] ? currentMessageId : history.currentId;
	if (!currentId || !msgs[currentId]?.role) {
		const leaves = Object.values(msgs).filter((m) => m.childrenIds.length === 0);
		leaves.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		currentId = leaves[0]?.id ?? Object.keys(msgs)[0] ?? null;
	}
	for (const [id, m] of Object.entries(msgs)) {
		if (m.parentId === undefined || (m.parentId && !msgs[m.parentId])) m.parentId = parentOf[id] ?? null;
		if (!m.role) {
			const parent = m.parentId ? msgs[m.parentId] : null;
			m.role = parent?.role === 'user' ? 'assistant' : parent?.role === 'assistant' ? 'user' : m.model || m.usage || m.done !== undefined ? 'assistant' : 'user';
		}
		if (m.role === 'assistant' && id !== currentId && m.done !== false) m.done = true;
	}
	return { messages: msgs, currentId };
}

/** The text of a backend error (FastAPI `detail`, OpenAI `error.message`/`error`, or `message`). */
export function errorText(error: unknown): string {
	if (!error) return '';
	if (typeof error === 'string') return error;
	const e = error as Record<string, any>;
	if ('detail' in e) return String(e.detail);
	if ('error' in e) return typeof e.error === 'object' && e.error && 'message' in e.error ? String(e.error.message) : String(e.error);
	if ('message' in e) return String(e.message);
	return '';
}

/** A reply marked failed: done, with the error shown in place (and the "searching knowledge" status dropped). */
export const failMessage = (m: Message, error: unknown): Partial<Message> => ({
	done: true,
	error: { content: `Uh-oh! There was an issue with the response.\n${errorText(error)}` },
	statusHistory: m.statusHistory?.filter((s) => s.action !== 'knowledge_search')
});

export type ChatEvent = { chat_id?: string; message_id?: string; data?: { type?: string; data?: any } };

/** Something the chat page must do in response to an event, beyond updating the history. */
export type ChatEffect =
	| { kind: 'done'; messageId: string; content: string }
	| { kind: 'error'; text: string }
	| { kind: 'reload' }
	| { kind: 'title'; title: string }
	| { kind: 'tags' }
	| { kind: 'inactive' }
	| { kind: 'cancelled' }
	| { kind: 'notification'; level: string; content: string }
	| { kind: 'dialog'; type: 'confirmation' | 'input' | 'execute' | 'ask_user'; data: any };

/** Strips `<details>` blocks (reasoning, tool calls) from a finished reply: what is copied or spoken. */
const visibleText = (m: Message) => getOutputText(m.output) || m.content.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '').trim();

/**
 * Applies one `events` socket event (Chat.svelte's chatEventHandler and its
 * chat:completion / response:completion handlers) to the history. Events for
 * messages this history does not hold are ignored.
 */
export function applyChatEvent(history: History, event: ChatEvent): { history: History; effects: ChatEffect[] } {
	const type = event.data?.type ?? '';
	const data = event.data?.data;
	const effects: ChatEffect[] = [];
	if (type === 'chat:reload') return { history, effects: [{ kind: 'reload' }] };
	const id = event.message_id ?? '';
	const message = history.messages[id];
	if (!message) return { history, effects };
	let patch: Partial<Message> = {};

	switch (type) {
		case 'status':
			patch = { statusHistory: [...(message.statusHistory ?? []), data] };
			break;
		case 'chat:active':
			if (!data?.active) effects.push({ kind: 'inactive' });
			break;
		case 'chat:completion': {
			const { done, choices, content, output, sources, selected_model_id, error, usage } = data ?? {};
			const m: Message = { ...message };
			if (output) {
				m.output = output;
				m.content = getOutputText(output);
			}
			if (error) {
				Object.assign(m, failMessage(m, error));
				effects.push({ kind: 'error', text: errorText(error) });
			}
			if (sources && !m.sources) m.sources = sources;
			if (choices && !output) {
				if (choices[0]?.message?.content) m.content += choices[0].message.content;
				else {
					const value = choices[0]?.delta?.content ?? '';
					if (!(m.content === '' && value === '\n')) m.content += value;
				}
			}
			if (content && !output) m.content = content;
			if (selected_model_id) {
				m.selectedModelId = selected_model_id;
				m.arena = true;
			}
			if (usage) m.usage = usage;
			if (done) {
				m.done = true;
				effects.push({ kind: 'done', messageId: id, content: visibleText(m) });
			}
			patch = m;
			break;
		}
		case 'response:completion': {
			const output = applyResponseStreamEvent(message.output ?? [], data);
			let content = message.content;
			if (data?.type === 'response.output_text.delta') {
				const value = data.delta ?? '';
				if (!(content === '' && value === '\n')) content += value;
			} else if (data?.type === 'response.completed' || data?.type?.endsWith('.done')) content = getOutputText(output) || content;
			patch = { output, content };
			break;
		}
		case 'chat:tasks:cancel':
			effects.push({ kind: 'cancelled' });
			if (id === history.currentId && message.parentId) {
				let h = history;
				for (const c of history.messages[message.parentId]?.childrenIds ?? []) h = updateMessage(h, c, { done: true });
				return { history: h, effects };
			}
			patch = { done: true };
			break;
		case 'chat:message:delta':
		case 'message':
			patch = { content: message.content + (data?.content ?? '') };
			break;
		case 'chat:message':
		case 'replace':
			patch = { content: data?.content ?? '' };
			break;
		case 'chat:message:files':
		case 'files':
			patch = { files: data?.files };
			break;
		case 'chat:message:embeds':
		case 'embeds':
			patch = { embeds: data?.embeds };
			break;
		case 'chat:message:error':
			patch = { error: data?.error };
			break;
		case 'chat:message:follow_ups':
			patch = { followUps: data?.follow_ups };
			break;
		case 'chat:message:favorite':
			patch = { favorite: data?.favorite };
			break;
		case 'chat:outlet': {
			let h = history;
			for (const msg of data?.messages ?? []) {
				const existing = h.messages[msg?.id];
				if (existing && existing.content !== msg.content) h = updateMessage(h, msg.id, { originalContent: existing.content, ...msg });
			}
			return { history: h, effects };
		}
		case 'chat:title':
			effects.push({ kind: 'title', title: String(data ?? '') });
			break;
		case 'chat:tags':
			effects.push({ kind: 'tags' });
			break;
		case 'source':
		case 'citation':
			if (data?.type === 'code_execution') {
				const list = [...(message.code_executions ?? [])];
				const i = list.findIndex((x) => x.id === data.id);
				if (i === -1) list.push(data);
				else list[i] = data;
				patch = { code_executions: list };
			} else patch = { sources: [...(message.sources ?? []), data] };
			break;
		case 'notification':
			effects.push({ kind: 'notification', level: data?.type ?? 'info', content: String(data?.content ?? '') });
			break;
		case 'confirmation':
		case 'input':
		case 'execute':
			effects.push({ kind: 'dialog', type, data });
			break;
		case 'request:user_input':
			effects.push({ kind: 'dialog', type: 'ask_user', data });
			break;
		default:
			break;
	}
	return { history: Object.keys(patch).length ? updateMessage(history, id, patch) : history, effects };
}

/** The last reply is still being written: the input queues or stops instead of sending. */
export const isGenerating = (history: History) => {
	const m = history.currentId ? history.messages[history.currentId] : null;
	return Boolean(m && m.role === 'assistant' && !m.done);
};

/** What the server should see of a message list (temporary chats send the whole conversation). */
export function toApiMessages(list: Message[]): Record<string, unknown>[] {
	return list
		.map((m) => {
			if (m.output && m.role === 'assistant') return { role: m.role, model: m.model, output: m.output };
			const images = (m.files ?? []).filter((f) => f.type === 'image' || (f.content_type ?? '').startsWith('image/'));
			const content = processDetails(m.content);
			if (m.role === 'user' && images.length) return { role: m.role, content: [{ type: 'text', text: content }, ...images.map((f) => ({ type: 'image_url', image_url: { url: f.url } }))] };
			return { role: m.role, content };
		})
		.filter((m) => m.role === 'user' || (typeof m.content === 'string' ? m.content.trim() : true) || (m as { output?: unknown[] }).output?.length);
}

export type Column = { modelIdx: number; messageIds: string[]; selected: number };

/**
 * The replies to a multi-model prompt as columns, one per model slot
 * (MultiResponseMessages.svelte): each column's regenerations in order, with
 * the one on the current path selected, else the latest.
 */
export function replyColumns(history: History, parentId: string): Column[] {
	const onPath = new Set(messagesList(history, history.currentId).map((m) => m.id));
	const byIdx = new Map<number, string[]>();
	for (const id of history.messages[parentId]?.childrenIds ?? []) {
		const m = history.messages[id];
		if (!m) continue;
		const idx = m.modelIdx ?? 0;
		byIdx.set(idx, [...(byIdx.get(idx) ?? []), id]);
	}
	return [...byIdx.entries()]
		.sort(([a], [b]) => a - b)
		.map(([modelIdx, messageIds]) => {
			const i = messageIds.findIndex((id) => onPath.has(id));
			return { modelIdx, messageIds, selected: i === -1 ? messageIds.length - 1 : i };
		});
}

/** Edits a message in place, keeping the previous text of a reply as `originalContent` (Messages.svelte's editMessage without submit). */
export function editContent(history: History, id: string, content: string, files?: ChatFile[]): History {
	const m = history.messages[id];
	if (!m) return history;
	if (m.role === 'user') return updateMessage(history, id, { content, ...(files ? { files } : {}) });
	return updateMessage(history, id, { originalContent: m.content, content });
}

/** "Save As Copy" for a reply: a new sibling with the edited text, which becomes current. */
export function saveReplyAsCopy(history: History, id: string, content: string): History {
	const m = history.messages[id];
	if (!m) return history;
	const copy: Message = { ...m, id: crypto.randomUUID(), childrenIds: [], files: undefined, content, timestamp: Math.floor(Date.now() / 1000) };
	const messages = { ...history.messages, [copy.id]: copy };
	if (m.parentId && messages[m.parentId]) messages[m.parentId] = { ...messages[m.parentId], childrenIds: [...messages[m.parentId].childrenIds, copy.id] };
	return { messages, currentId: copy.id };
}

/**
 * Removes a message and its direct replies; their replies move up to the
 * message's parent, and the newest branch from there becomes current
 * (Messages.svelte's deleteMessage).
 */
export function deleteMessage(history: History, id: string): History {
	const target = history.messages[id];
	if (!target) return history;
	const messages = { ...history.messages };
	const children = target.childrenIds ?? [];
	const grandchildren = children.flatMap((c) => messages[c]?.childrenIds ?? []);
	const parentId = target.parentId;
	if (parentId && messages[parentId]) messages[parentId] = { ...messages[parentId], childrenIds: [...messages[parentId].childrenIds.filter((c) => c !== id), ...grandchildren] };
	for (const g of grandchildren) if (messages[g]) messages[g] = { ...messages[g], parentId };
	for (const d of [id, ...children]) delete messages[d];
	let next: string | null = parentId;
	let kids = next === null ? Object.keys(messages).filter((k) => messages[k].parentId === null) : (messages[next]?.childrenIds ?? []);
	while (kids.length) {
		next = kids.at(-1)!;
		kids = messages[next]?.childrenIds ?? [];
	}
	return { messages, currentId: next };
}

/** A reply stopped part-way can be continued. */
export const canContinue = (m: Message) => m.role === 'assistant' && m.done !== false && !m.error && Boolean(m.content);
