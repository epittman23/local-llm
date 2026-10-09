// Chat import (Settings/DataControls.svelte and utils/index.ts's
// getImportOrigin / convertOpenAIChats): an export from this app, or a
// ChatGPT export converted into this app's shape.

type Rec = Record<string, any>;

/** A ChatGPT export has conversations with a `mapping` tree. */
export const importOrigin = (chats: Rec[]) =>
	chats.some((c) => c && typeof c === 'object' && 'mapping' in c) ? 'openai' : 'webui';

function openAIText(message: Rec | null | undefined): string {
	const parts = message?.content?.parts;
	if (Array.isArray(parts)) {
		const text = parts.filter((p) => typeof p === 'string');
		if (text.length) return text.join('\n');
	}
	return message?.content?.text || '';
}

function convertConversation(convo: Rec) {
	const messages: Rec[] = [];
	let lastId: string | null = null;
	const models = new Set<string>();
	for (const [id, node] of Object.entries<Rec>(convo.mapping ?? {})) {
		const m = node?.message;
		if (!messages.length && (m == null || (m?.content?.parts?.[0] === '' && m?.content?.text == null))) continue;
		const role = m?.author?.role;
		if (role === 'system' || role === 'tool') continue;
		const model = m?.metadata?.model_slug || 'gpt-3.5-turbo';
		const timestamp = m?.create_time ? Math.floor(m.create_time) : undefined;
		messages.push({
			id,
			parentId: lastId,
			childrenIds: node.children || [],
			role: role !== 'user' ? 'assistant' : 'user',
			content: openAIText(m),
			model,
			done: true,
			context: null,
			...(timestamp !== undefined ? { timestamp } : {})
		});
		if (role !== 'user') models.add(model);
		lastId = id;
	}
	if (messages.length) messages[messages.length - 1].childrenIds = [];
	// The Svelte converter set currentId to the last id it *visited*, which can be
	// a skipped system/tool message; the last message kept is what is shown.
	return {
		history: { currentId: lastId, messages: Object.fromEntries(messages.map((m) => [m.id, m])) },
		models: models.size ? [...models] : ['gpt-3.5-turbo'],
		messages,
		options: {},
		timestamp: convo.create_time,
		title: convo.title ?? 'New Chat'
	};
}

/** ChatGPT conversations as this app's chats; entries without messages (folders, projects) or with non-text content are skipped. */
export function convertOpenAIChats(chats: Rec[]): Rec[] {
	const out: Rec[] = [];
	for (const convo of chats) {
		if (!convo || !('mapping' in convo)) continue;
		const chat = convertConversation(convo);
		if (!chat.messages.length || chat.messages.some((m) => typeof m.content !== 'string')) continue;
		const created = convo.create_time ? Math.floor(convo.create_time) : null;
		out.push({
			id: convo.id,
			user_id: '',
			title: convo.title,
			chat,
			created_at: created,
			updated_at: convo.update_time ? Math.floor(convo.update_time) : created
		});
	}
	return out;
}

/** The import request body: each chat unpinned, keeping its folder and dates (an old export is a bare chat object). */
export const importPayload = (chats: Rec[]) =>
	chats.map((c) =>
		c.chat
			? {
					chat: c.chat,
					meta: c.meta ?? {},
					pinned: false,
					folder_id: c.folder_id ?? null,
					created_at: c.created_at ?? null,
					updated_at: c.updated_at ?? null
				}
			: {
					chat: c,
					meta: {},
					pinned: false,
					folder_id: null,
					created_at: c?.created_at ?? null,
					updated_at: c?.updated_at ?? null
				}
	);

/** Reads an export file: this app's own, or ChatGPT's (converted). Throws on anything that is not a list of chats. */
export function parseChatExport(text: string): Rec[] {
	const data = JSON.parse(text);
	if (!Array.isArray(data)) throw new Error('Not a chat export.');
	return importOrigin(data) === 'openai' ? convertOpenAIChats(data) : data;
}
