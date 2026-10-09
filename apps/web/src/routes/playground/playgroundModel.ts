// The rules behind the Playground (components/playground/*.svelte): reading an
// OpenAI-style server-sent-event stream, the messages sent, and the two export
// formats. The Svelte Chat and Completions pages each carry their own copy of
// the stream loop; here it is one function both use.

export type PlaygroundMessage = { role: 'user' | 'assistant'; content: string };

/**
 * The text a single SSE line adds: the `delta.content` of a `data: {...}` line.
 * Blank lines, `[DONE]`, comments and anything unparsable add nothing.
 */
export function deltaFromLine(line: string): string {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return '';
	const payload = trimmed.slice(5).trim();
	if (!payload || payload === '[DONE]') return '';
	try {
		return JSON.parse(payload)?.choices?.[0]?.delta?.content ?? '';
	} catch {
		return '';
	}
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
	signal?: AbortSignal
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
		}
		if (!signal?.aborted && buffer) {
			const text = deltaFromLine(buffer);
			if (text) onText(text);
		}
	} catch (err) {
		if (!signal?.aborted) throw err;
	} finally {
		reader.releaseLock();
	}
}

/** The request body: an optional system message, the conversation, and whichever parameters are set. */
export function chatRequest(
	modelId: string,
	system: string,
	messages: PlaygroundMessage[],
	params: Record<string, unknown>
) {
	const active = Object.fromEntries(
		Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
	);
	return {
		model: modelId,
		stream: true,
		messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
		...active
	};
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
	newId: () => string = () => crypto.randomUUID()
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
export function initialModel(settingsModels: unknown, defaultModels: string | null | undefined): string {
	if (Array.isArray(settingsModels) && typeof settingsModels[0] === 'string' && settingsModels[0])
		return settingsModels[0];
	return (defaultModels ?? '').split(',')[0] ?? '';
}
