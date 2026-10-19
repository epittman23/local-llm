import { describe, expect, it } from 'vitest';
import { editContent, saveReplyAsCopy, toApiMessages, messagesList, type History } from '@/lib/chat/history';
import { getOutputText } from '@/lib/chat/structuredOutput';

const output = [{ type: 'message', id: 'o1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The answer is 41.' }] }];
const h: History = {
	currentId: 'a',
	messages: {
		u: { id: 'u', parentId: null, childrenIds: ['a'], role: 'user', content: 'what is 6*7?' },
		a: { id: 'a', parentId: 'u', childrenIds: [], role: 'assistant', content: 'The answer is 41.', output: output as never, done: true }
	}
};

describe('editing a reply that has output', () => {
	it('save: content changes, output (what the model sees) does not', () => {
		const e = editContent(h, 'a', 'The answer is 42.');
		console.log('edited content:', e.messages.a.content);
		console.log('getOutputText:', getOutputText(e.messages.a.output));
		console.log('toApiMessages:', JSON.stringify(toApiMessages(messagesList(e, 'a'))));
		expect(e.messages.a.content).toBe('The answer is 42.');
		expect(getOutputText(e.messages.a.output)).toBe('The answer is 41.');
	});
	it('save as copy: the copy keeps the old output', () => {
		const c = saveReplyAsCopy(h, 'a', 'The answer is 42.');
		const copy = c.messages[c.currentId!];
		console.log('copy content:', copy.content, '| copy output text:', getOutputText(copy.output));
		console.log('toApiMessages(copy path):', JSON.stringify(toApiMessages(messagesList(c, c.currentId))));
		expect(getOutputText(copy.output)).toBe('The answer is 41.');
	});
});
