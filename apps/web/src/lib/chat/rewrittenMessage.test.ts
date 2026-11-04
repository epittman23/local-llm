// A message an action function or an outlet filter rewrote takes the new
// text into its `output` too, which the next request is built from (#502).
import { describe, expect, it } from 'vitest';
import { applyChatEvent, type History, type Message, rewrittenMessage } from './history';
import { getOutputText, type OutputItem } from './structuredOutput';

const text = (t: string, id = 'msg1'): OutputItem => ({
	type: 'message',
	id,
	role: 'assistant',
	content: [{ type: 'output_text', text: t }]
});
const call: OutputItem = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'lookup', status: 'completed' };

const reply = (content: string, output?: OutputItem[]) =>
	({ id: 'r', role: 'assistant', content, output, parentId: null, childrenIds: [] }) as unknown as Message;

describe('rewrittenMessage (#502)', () => {
	it("puts the new text in the output's message, keeping its other items", () => {
		const patch = rewrittenMessage(reply('Old answer', [call, text('Old answer')]), { content: 'New answer' });

		expect(patch.originalContent).toBe('Old answer');
		expect(patch.output?.[0]).toEqual(call);
		expect(getOutputText(patch.output)).toBe('New answer');
	});

	it('replaces the text even when it spans several message items', () => {
		const existing = reply('First\nSecond', [text('First', 'a'), call, text('Second', 'b')]);

		const patch = rewrittenMessage(existing, { content: 'All new' });

		expect(getOutputText(patch.output)).toBe('All new');
		expect(patch.output?.map((i) => i.type)).toEqual(['message', 'function_call']);
	});

	it('keeps an output the rewrite brings, and changes nothing when the text is the same', () => {
		const own = [text('From the action')];
		expect(rewrittenMessage(reply('Old', [text('Old')]), { content: 'New', output: own }).output).toBe(own);
		expect(rewrittenMessage(reply('Same', [text('Same')]), { content: 'Same', info: {} as never })).toEqual({
			content: 'Same',
			info: {}
		});
	});

	it('takes an output the rewrite sends back unchanged as not its own', () => {
		const output = [text('Old')];
		const patch = rewrittenMessage(reply('Old', output), { content: 'New', output: structuredClone(output) });

		expect(getOutputText(patch.output)).toBe('New');
	});

	it('leaves a message with no output without one', () => {
		expect(rewrittenMessage(reply('Old'), { content: 'New' })).toEqual({ originalContent: 'Old', content: 'New' });
	});

	it('is what an outlet filter event applies', () => {
		const history = {
			messages: { r: reply('Old answer', [text('Old answer')]) },
			currentId: 'r'
		} as unknown as History;
		const event = {
			chat_id: 'c',
			message_id: 'r',
			data: { type: 'chat:outlet', data: { messages: [{ id: 'r', content: 'Filtered' }] } }
		};

		const next = applyChatEvent(history, event as never).history.messages.r;

		expect(next.content).toBe('Filtered');
		expect(next.originalContent).toBe('Old answer');
		expect(getOutputText(next.output)).toBe('Filtered');
	});
});
