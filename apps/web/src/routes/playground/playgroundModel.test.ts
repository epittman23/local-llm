import { describe, expect, it } from 'vitest';
import {
	appendAssistant,
	canCompleteText,
	chatRequest,
	chatToExport,
	chatToText,
	completionModel,
	completionRequest,
	deltaFromLine,
	formatStats,
	initialModel,
	readCompletionStream,
	usageFromLine
} from './playgroundModel';

const event = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;
const streamOf = (...chunks: string[]) =>
	new Response(
		new ReadableStream({
			start(c) {
				for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
				c.close();
			}
		})
	);

describe('deltaFromLine', () => {
	it('reads content and ignores everything else', () => {
		expect(deltaFromLine(event('Hi').trim())).toBe('Hi');
		expect(deltaFromLine('data: [DONE]')).toBe('');
		expect(deltaFromLine(': keep-alive')).toBe('');
		expect(deltaFromLine('data: {broken')).toBe('');
		expect(deltaFromLine('data: {"choices":[{"delta":{}}]}')).toBe('');
	});
	it("reads a text completion's text too (#1108)", () => {
		expect(deltaFromLine('data: {"choices":[{"text":" world","index":0}]}')).toBe(' world');
		expect(deltaFromLine('data: {"choices":[{"text":7}]}')).toBe('');
	});
});

describe('usage and speed (D8)', () => {
	it('reads the usage a chunk reports, and nothing from other lines', () => {
		expect(usageFromLine('data: {"choices":[],"usage":{"completion_tokens":9}}')).toEqual({ completion_tokens: 9 });
		expect(usageFromLine(event('x').trim())).toBeNull();
		expect(usageFromLine('data: [DONE]')).toBeNull();
	});
	it('reports usage from the stream, also on a last line with no newline', async () => {
		const seen: unknown[] = [];
		const usage = 'data: {"choices":[],"usage":{"completion_tokens":4}}';
		await readCompletionStream(
			streamOf(event('a') + usage),
			() => {},
			undefined,
			(u) => seen.push(u)
		);
		expect(seen).toEqual([{ completion_tokens: 4 }]);
		await readCompletionStream(
			streamOf(`${usage}\n`),
			() => {},
			undefined,
			(u) => seen.push(u)
		);
		expect(seen).toHaveLength(2);
	});
	it('says the time to the first token always, and the tokens and rate when known', () => {
		expect(formatStats(undefined)).toBe('');
		expect(formatStats({})).toBe('');
		expect(formatStats({ ttftMs: 420 })).toBe('First token in 0.42 s');
		expect(formatStats({ ttftMs: 1500, tokens: 1 })).toBe('First token in 1.50 s · 1 token');
		expect(formatStats({ ttftMs: 1500, tokens: 312, tokensPerSecond: 54.06 })).toBe(
			'First token in 1.50 s · 312 tokens · 54.1 tokens/s'
		);
	});
});

describe('a text completion request (#1108)', () => {
	it('sends the text as the prompt, with only the parameters set, under params', () => {
		expect(completionRequest('m', 'Once', { temperature: 0.4, top_p: null })).toEqual({
			model: 'm',
			stream: true,
			prompt: 'Once',
			params: { temperature: 0.4 }
		});
		expect(completionRequest('m', 'Once', {})).not.toHaveProperty('params');
	});
});

describe('readCompletionStream', () => {
	it('joins an event split across chunks', async () => {
		const full = event('Hello') + event(' world') + 'data: [DONE]\n';
		const out: string[] = [];
		await readCompletionStream(streamOf(full.slice(0, 20), full.slice(20, 45), full.slice(45)), (t) => out.push(t));
		expect(out.join('')).toBe('Hello world');
	});
	it('reads a last line with no trailing newline', async () => {
		const out: string[] = [];
		await readCompletionStream(streamOf(event('a') + event('b').trim()), (t) => out.push(t));
		expect(out.join('')).toBe('ab');
	});
	it('throws the server detail on an error response', async () => {
		const res = new Response(JSON.stringify({ detail: 'Model not found' }), { status: 404 });
		await expect(readCompletionStream(res, () => {})).rejects.toThrow('Model not found');
	});
	it('stops quietly once aborted', async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const out: string[] = [];
		await readCompletionStream(streamOf(event('x')), (t) => out.push(t), ctrl.signal);
		expect(out).toEqual([]);
	});
});

describe('messages', () => {
	it('builds the request with the system first and only set parameters', () => {
		expect(
			chatRequest('m', 'Be brief', [{ role: 'user', content: 'Hi' }], { temperature: 0.2, top_p: null, stop: '' })
		).toEqual({
			model: 'm',
			stream: true,
			messages: [
				{ role: 'system', content: 'Be brief' },
				{ role: 'user', content: 'Hi' }
			],
			params: { temperature: 0.2 }
		});
	});
	it('sends the parameters under params, custom and app-only ones too, for the backend to sort (#208)', () => {
		const body = chatRequest('m', '', [{ role: 'user', content: 'Hi' }], {
			temperature: 0.2,
			function_calling: 'native',
			custom_params: { top_k: '40' }
		});
		expect(body).toEqual({
			model: 'm',
			stream: true,
			messages: [{ role: 'user', content: 'Hi' }],
			params: { temperature: 0.2, function_calling: 'native', custom_params: { top_k: '40' } }
		});
		expect(body).not.toHaveProperty('temperature');
		expect(body).not.toHaveProperty('function_calling');
	});
	it("sends a message's role and text only, never the speed shown under it", () => {
		const body = chatRequest('m', '', [{ role: 'assistant', content: 'A', stats: { ttftMs: 1 } }], {});
		expect(body.messages).toEqual([{ role: 'assistant', content: 'A' }]);
	});
	it('sends no params when none is set', () => {
		expect(chatRequest('m', '', [], { top_p: null, stop: '' })).not.toHaveProperty('params');
	});
	it('streams into the last assistant message, or starts one, skipping a leading newline', () => {
		const one = appendAssistant([{ role: 'user', content: 'Hi' }], '\n');
		expect(one).toEqual([
			{ role: 'user', content: 'Hi' },
			{ role: 'assistant', content: '' }
		]);
		expect(appendAssistant(appendAssistant(one, 'Hel'), 'lo').at(-1)).toEqual({ role: 'assistant', content: 'Hello' });
	});
	it('exports text and the chat-import format as one chain', () => {
		const msgs = [
			{ role: 'user' as const, content: 'Q' },
			{ role: 'assistant' as const, content: 'A' }
		];
		expect(chatToText('S', msgs)).toBe('### SYSTEM\nS\n\n### USER\nQ\n\n### ASSISTANT\nA');
		let n = 0;
		const [out] = chatToExport('S', msgs, 'm', 100, () => `id${++n}`);
		expect(out.chat.history.currentId).toBe('id3');
		expect(out.chat.history.messages.id1).toMatchObject({ role: 'system', parentId: null, childrenIds: ['id2'] });
		expect(out.chat.history.messages.id3).toMatchObject({ role: 'assistant', parentId: 'id2', model: 'm' });
		expect(out.chat.params).toEqual({ system: 'S' });
	});
	it('starts on the user model, else the default', () => {
		expect(initialModel(['a', 'b'], 'x,y')).toBe('a');
		expect(initialModel(undefined, 'x,y')).toBe('x');
		expect(initialModel([], null)).toBe('');
	});
});

describe('the models that can continue text (S6-D6)', () => {
	const models = [
		{ id: 'qwen', name: 'Qwen', owned_by: 'openai' },
		{ id: 'llama3', name: 'Llama 3', owned_by: 'ollama' },
		{ id: 'fn.pipe', name: 'A pipe', owned_by: 'openai', pipe: { type: 'pipe' } },
		{ id: 'mine', name: 'Direct', owned_by: 'openai', direct: true },
		{ id: 'arena', name: 'Arena', owned_by: 'arena', arena: true },
		{ id: 'coder', name: 'Coder', owned_by: 'openai' }
	];

	it('are those on an OpenAI-compatible connection, not a pipe, a direct connection or an arena', () => {
		expect(models.filter(canCompleteText).map((m) => m.id)).toEqual(['qwen', 'coder']);
	});

	it('keep a usable or unknown choice, and move off one that cannot continue text', () => {
		expect(completionModel(models, 'coder', 'qwen')).toBe('coder');
		expect(completionModel(models, 'gone', 'qwen')).toBe('gone');
		expect(completionModel(models, 'llama3', 'coder')).toBe('coder');
		expect(completionModel(models, '', 'llama3')).toBe('qwen');
		expect(completionModel(models.slice(1, 5), '', 'qwen')).toBe('');
	});
});
