import { describe, expect, it } from 'vitest';
import {
	appendAssistant,
	chatRequest,
	chatToExport,
	chatToText,
	deltaFromLine,
	initialModel,
	readCompletionStream
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
			temperature: 0.2
		});
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
