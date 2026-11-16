// The rules behind the Playground (components/playground/*.svelte): reading an
// OpenAI-style server-sent-event stream, the messages sent, and the two export
// formats. The Svelte Chat and Completions pages each carry their own copy of
// the stream loop; here it is one function both use.

import { uuid } from '@/lib/utils/uuid';

/** How fast a reply came: time to its first token always; its token count and rate when the provider reported usage. */
export type PlaygroundStats = { ttftMs?: number; tokens?: number; tokensPerSecond?: number };

export type PlaygroundMessage = { role: 'user' | 'assistant'; content: string; stats?: PlaygroundStats };

/** What a provider reports in a stream's `usage` (OpenAI's names). */
export type StreamUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

/** The JSON event of a `data: {...}` SSE line, or null for blank lines, `[DONE]`, comments and anything unparsable. */
type StreamEvent = { choices?: { delta?: { content?: unknown }; text?: unknown }[]; usage?: unknown };

function eventOf(line: string): StreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return null;
	const payload = trimmed.slice(5).trim();
	if (!payload || payload === '[DONE]') return null;
	try {
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

/**
 * The text a single SSE line adds: a chat chunk's `delta.content`, or a text
 * completion's `text` (`/completions` streams that instead). Blank lines,
 * `[DONE]`, comments and anything unparsable add nothing.
 */
export function deltaFromLine(line: string): string {
	const choice = eventOf(line)?.choices?.[0];
	const text = choice?.delta?.content ?? choice?.text;
	return typeof text === 'string' ? text : '';
}

/** The `usage` a line reports (most providers send it once, on the last chunk), or null. */
export function usageFromLine(line: string): StreamUsage | null {
	const usage = eventOf(line)?.usage;
	return usage && typeof usage === 'object' ? (usage as StreamUsage) : null;
}

/**
 * The line under a reply (D8): time to first token always, then the tokens
 * and tokens per second when the provider reported them.
 */
export function formatStats(stats: PlaygroundStats | undefined): string {
	if (stats?.ttftMs === undefined) return '';
	const parts = [`First token in ${(stats.ttftMs / 1000).toFixed(2)} s`];
	if (stats.tokens !== undefined) parts.push(`${stats.tokens} ${stats.tokens === 1 ? 'token' : 'tokens'}`);
	if (stats.tokensPerSecond !== undefined) parts.push(`${stats.tokensPerSecond.toFixed(1)} tokens/s`);
	return parts.join(' · ');
}

/**
 * Reads a streamed completion, calling `onText` with each piece. Lines are
 * joined across network chunks (a JSON event split between two reads is
 * still parsed). Stops quietly when `signal` aborts. Throws on a non-OK
 * response with the server's `detail` when it has one -- the Svelte loop
 * ignored a failed response entirely, so a bad model id looked like silence.
 */
export async function readCompletionStream(
	res: Response | null,
	onText: (text: string) => void,
	signal?: AbortSignal,
	onUsage?: (usage: StreamUsage) => void
): Promise<void> {
	if (!res) throw new Error('No response');
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.detail ?? body?.error?.message ?? `${res.status} ${res.statusText}`);
	}
	if (!res.body) return;
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	try {
		while (!signal?.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			const text = lines.map(deltaFromLine).join('');
			if (text) onText(text);
			reportUsage(lines, onUsage);
		}
		if (!signal?.aborted && buffer) {
			const text = deltaFromLine(buffer);
			if (text) onText(text);
			reportUsage([buffer], onUsage);
		}
	} catch (err) {
		if (!signal?.aborted) throw err;
	} finally {
		reader.releaseLock();
	}
}

function reportUsage(lines: string[], onUsage?: (usage: StreamUsage) => void) {
	if (!onUsage) return;
	for (const line of lines) {
		const usage = usageFromLine(line);
		if (usage) onUsage(usage);
	}
}

/** Only the parameters that are set: an empty field means "the model's default". */
function activeParams(params: Record<string, unknown>) {
	const active = Object.fromEntries(
		Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
	);
	return Object.keys(active).length ? { params: active } : {};
}

/**
 * The request body: an optional system message, the conversation, and
 * whichever parameters are set, under `params`, the field the chat page uses
 * too (the chat page also splits `stop` into sequences; this sends it as typed).
 * The backend reads only `params`: it applies the provider's parameters from
 * it, decodes `custom_params`, and keeps this app's own settings (function
 * calling, reasoning tags, ...) from the provider. Spread at the top level,
 * custom parameters were never applied and those settings reached the
 * provider as unknown fields (#208).
 */
export function chatRequest(
	modelId: string,
	system: string,
	messages: PlaygroundMessage[],
	params: Record<string, unknown>
) {
	return {
		model: modelId,
		stream: true,
		// Only the role and the text: a message's speed line is the page's, not the model's.
		messages: [
			...(system ? [{ role: 'system', content: system }] : []),
			...messages.map(({ role, content }) => ({ role, content }))
		],
		...activeParams(params)
	};
}

/** A text completion's body (`/openai/completions`): the text the model continues, and the parameters set, as Chat sends them. */
export function completionRequest(modelId: string, prompt: string, params: Record<string, unknown>) {
	return { model: modelId, stream: true, prompt, ...activeParams(params) };
}

/** Appends streamed text to the last message if it is the assistant's, else starts an assistant message. */
export function appendAssistant(messages: PlaygroundMessage[], text: string): PlaygroundMessage[] {
	const last = messages.at(-1);
	// The first piece of a reply is often a lone newline; the original skipped it.
	if (last?.role === 'assistant')
		return [
			...messages.slice(0, -1),
			{ ...last, content: last.content === '' && text === '\n' ? '' : last.content + text }
		];
	return [...messages, { role: 'assistant', content: text === '\n' ? '' : text }];
}

/** "### ROLE\ncontent" blocks, the system prompt first. */
export function chatToText(system: string, messages: PlaygroundMessage[]): string {
	return [
		...(system ? [`### SYSTEM\n${system}`] : []),
		...messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`)
	]
		.join('\n\n')
		.trim();
}

/**
 * The chat-import format the rest of the app reads (a one-element array of
 * `{chat: {history: {messages, currentId}}}`), so a playground conversation
 * can be imported as an ordinary chat. Messages form one linked chain.
 */
export function chatToExport(
	system: string,
	messages: PlaygroundMessage[],
	modelId: string,
	now = Math.floor(Date.now() / 1000),
	newId: () => string = () => uuid()
) {
	const map: Record<
		string,
		{
			id: string;
			parentId: string | null;
			childrenIds: string[];
			role: string;
			content: string;
			timestamp: number;
			model?: string;
		}
	> = {};
	let parentId: string | null = null;
	const add = (role: string, content: string) => {
		const id = newId();
		if (parentId) map[parentId].childrenIds.push(id);
		map[id] = {
			id,
			parentId,
			childrenIds: [],
			role,
			content,
			timestamp: now,
			...(role === 'assistant' && modelId ? { model: modelId } : {})
		};
		parentId = id;
	};
	if (system) add('system', system);
	for (const m of messages) add(m.role, m.content);
	return [
		{
			chat: {
				title: 'Playground Chat',
				models: [modelId],
				params: system ? { system } : {},
				history: { messages: map, currentId: messages.length ? parentId : null }
			},
			meta: {},
			pinned: false,
			created_at: now,
			updated_at: now
		}
	];
}

/** The model a playground starts on: the user's first chosen model, else the admin default, else none. */
/**
 * A text completion's failure in words: a bare "404 Not Found" (a provider
 * with no /completions answers that, with no body to explain it) says what it
 * means. Anything with the server's own words is kept as it is.
 */
export function completionFailure(error: string): string {
	return /^404\b/.test(error.trim()) && error.trim().length <= 20
		? "This model's connection doesn't offer text completion (404)."
		: error;
}

/** What the Playground reads of a model from /api/models. */
export type PlaygroundModelInfo = {
	id: string;
	name: string;
	owned_by?: string;
	pipe?: unknown;
	direct?: boolean;
	arena?: boolean;
};

/**
 * Whether a model can continue text (S6-D6): only one on an OpenAI-compatible
 * connection has a /completions to call. A function's pipe reports itself as
 * `openai` too, and a direct connection is the browser's own, so both are out.
 */
export const canCompleteText = (m: PlaygroundModelInfo) => m.owned_by === 'openai' && !m.pipe && !m.direct && !m.arena;

/**
 * The Completions tab's model: the one chosen, unless it is a model that can't
 * continue text, else `start` if it can, else the first that can. An id no
 * model has is kept, as the Chat tab keeps it.
 */
export function completionModel(models: PlaygroundModelInfo[], chosen: string, start: string): string {
	const usable = (id: string) => models.some((m) => m.id === id && canCompleteText(m));
	if (chosen && (usable(chosen) || !models.some((m) => m.id === chosen))) return chosen;
	return usable(start) ? start : (models.find(canCompleteText)?.id ?? '');
}

export function initialModel(settingsModels: unknown, defaultModels: string | null | undefined): string {
	if (Array.isArray(settingsModels) && typeof settingsModels[0] === 'string' && settingsModels[0])
		return settingsModels[0];
	return (defaultModels ?? '').split(',')[0] ?? '';
}
