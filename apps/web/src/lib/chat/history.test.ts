// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	addResponses,
	addUserMessage,
	applyChatEvent,
	editContent,
	emptyHistory,
	finishReplies,
	type History,
	isGenerating,
	messagesList,
	normalizeHistory,
	replyColumns,
	saveReplyAsCopy,
	showBranch,
	siblingsOf,
	toApiMessages,
	updateMessage
} from './history';
import { getOutputText } from './structuredOutput';

function conversation() {
	let h = emptyHistory();
	const u = addUserMessage(h, null, { content: 'hi', models: ['m1'] });
	const r = addResponses(u.history, u.id, [{ id: 'm1', name: 'Model 1' }]);
	h = r.history;
	return { h, userId: u.id, replyId: r.targets[0].message_id };
}

describe('building a conversation', () => {
	it('links user and reply and makes the reply current', () => {
		const { h, userId, replyId } = conversation();
		expect(h.currentId).toBe(replyId);
		expect(h.messages[userId].childrenIds).toEqual([replyId]);
		expect(messagesList(h, replyId).map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(isGenerating(h)).toBe(true);
	});
	it('never mutates the history it was given', () => {
		const { h, userId } = conversation();
		const before = JSON.stringify(h);
		addResponses(h, userId, [{ id: 'm2' }]);
		updateMessage(h, userId, { content: 'x' });
		expect(JSON.stringify(h)).toBe(before);
	});
	it('fans out to several models with their column index', () => {
		const u = addUserMessage(emptyHistory(), null, { content: 'q' });
		const { targets } = addResponses(u.history, u.id, [{ id: 'a' }, { id: 'a' }]);
		expect(targets.map((t) => [t.model_id, t.modelIdx])).toEqual([
			['a', 0],
			['a', 1]
		]);
	});
	it('navigates siblings to the newest branch below', () => {
		const { h, userId } = conversation();
		const again = addResponses(h, userId, [{ id: 'm1' }]).history;
		const first = again.messages[userId].childrenIds[0];
		expect(siblingsOf(again, again.messages[first])).toHaveLength(2);
		expect(showBranch(again, first).currentId).toBe(first);
		expect(showBranch(again, userId).currentId).toBe(again.messages[userId].childrenIds[1]);
	});
});

describe('streaming events', () => {
	const ev = (message_id: string, type: string, data: unknown) => ({ chat_id: 'c', message_id, data: { type, data } });

	it('appends OpenAI deltas, skips a leading newline, and finishes', () => {
		let { h, replyId } = conversation();
		h = applyChatEvent(h, ev(replyId, 'chat:completion', { choices: [{ delta: { content: '\n' } }] })).history;
		h = applyChatEvent(h, ev(replyId, 'chat:completion', { choices: [{ delta: { content: 'Hel' } }] })).history;
		h = applyChatEvent(h, ev(replyId, 'chat:completion', { choices: [{ delta: { content: 'lo' } }] })).history;
		const end = applyChatEvent(h, ev(replyId, 'chat:completion', { done: true, usage: { total_tokens: 3 } }));
		expect(end.history.messages[replyId]).toMatchObject({ content: 'Hello', done: true, usage: { total_tokens: 3 } });
		expect(end.effects).toEqual([{ kind: 'done', messageId: replyId, content: 'Hello' }]);
	});
	it('takes structured output as the content', () => {
		const { h, replyId } = conversation();
		const out = applyChatEvent(
			h,
			ev(replyId, 'chat:completion', {
				output: [{ type: 'message', content: [{ type: 'output_text', text: 'From output' }] }]
			})
		).history;
		expect(out.messages[replyId].content).toBe('From output');
	});
	it('marks an error on the reply and reports it', () => {
		const { h, replyId } = conversation();
		const r = applyChatEvent(h, ev(replyId, 'chat:completion', { error: { detail: 'Model not found' } }));
		expect(r.history.messages[replyId].done).toBe(true);
		expect(String(r.history.messages[replyId].error?.content)).toContain('Model not found');
		expect(r.effects).toContainEqual({ kind: 'error', text: 'Model not found' });
	});
	it('collects status, sources, code executions, follow-ups and title', () => {
		let { h, replyId } = conversation();
		h = applyChatEvent(h, ev(replyId, 'status', { description: 'Searching' })).history;
		h = applyChatEvent(h, ev(replyId, 'source', { source: { name: 'doc' } })).history;
		h = applyChatEvent(h, ev(replyId, 'source', { type: 'code_execution', id: 'x', code: '1' })).history;
		h = applyChatEvent(h, ev(replyId, 'source', { type: 'code_execution', id: 'x', code: '2' })).history;
		h = applyChatEvent(h, ev(replyId, 'chat:message:follow_ups', { follow_ups: ['more?'] })).history;
		const m = h.messages[replyId];
		expect([m.statusHistory?.length, m.sources?.length, m.code_executions, m.followUps]).toEqual([
			1,
			1,
			[{ type: 'code_execution', id: 'x', code: '2' }],
			['more?']
		]);
		expect(applyChatEvent(h, ev(replyId, 'chat:title', 'Greeting')).effects).toEqual([
			{ kind: 'title', title: 'Greeting' }
		]);
	});
	it('ignores events for messages it does not hold', () => {
		const { h } = conversation();
		expect(applyChatEvent(h, ev('nope', 'chat:message:delta', { content: 'x' })).history).toBe(h);
	});
	it('cancelling the current reply finishes every reply to the same prompt', () => {
		const { h, userId } = conversation();
		const two = addResponses(h, userId, [{ id: 'b' }]).history;
		const r = applyChatEvent(two, ev(two.currentId!, 'chat:tasks:cancel', {}));
		expect(two.messages[userId].childrenIds.every((c) => r.history.messages[c].done)).toBe(true);
		expect(r.effects).toContainEqual({ kind: 'cancelled', current: true });
	});
	it('a cancel for a reply a later send replaced is not the current one (#516)', () => {
		const { h } = conversation();
		const old = h.currentId ?? '';
		const next = addUserMessage(h, old, { content: 'again' });
		const later = addResponses(next.history, next.id, [{ id: 'a' }]).history;
		const r = applyChatEvent(later, ev(old, 'chat:tasks:cancel', {}));
		expect(r.effects).toContainEqual({ kind: 'cancelled', current: false });
		expect(r.history.messages[old].done).toBe(true);
	});
});

describe('loading and sending', () => {
	it('repairs a broken history from the server', () => {
		const h = normalizeHistory({
			messages: {
				a: { role: 'user', content: 'q', childrenIds: ['b', 'gone'] } as any,
				b: { content: 'r', parentId: 'a', model: 'm', done: false } as any,
				junk: null as any
			},
			currentId: 'missing'
		});
		expect(Object.keys(h.messages)).toEqual(['a', 'b']);
		expect(h.messages.a.childrenIds).toEqual(['b']);
		expect(h.messages.b.role).toBe('assistant');
		expect(h.currentId).toBe('b');
	});
	it('with nothing generating, finishes every reply left unfinished, not only the current one (#150)', () => {
		// A multi-model column interrupted mid-stream: the sibling that is not
		// current was saved unfinished, and stays so through normalisation in
		// case its task is still running.
		const h = normalizeHistory({
			messages: {
				q: { id: 'q', parentId: null, role: 'user', content: 'q', childrenIds: ['a', 'b'] },
				a: { id: 'a', parentId: 'q', role: 'assistant', content: 'x', childrenIds: [], done: true },
				b: { id: 'b', parentId: 'q', role: 'assistant', content: 'y', childrenIds: [], done: false }
			},
			currentId: 'a'
		});
		expect(h.messages.b.done).toBe(false);
		const finished = finishReplies(h);
		expect([finished.messages.a.done, finished.messages.b.done]).toEqual([true, true]);
		expect(finished.messages.q.done).toBeUndefined();
		expect(finishReplies(finished)).toBe(finished);
	});
	it('marks non-current replies done and builds from a flat list', () => {
		const h = normalizeHistory(null, [
			{ id: 'a', role: 'user', content: 'q' },
			{ id: 'b', role: 'assistant', content: 'r' }
		]);
		expect(h.messages.b.parentId).toBe('a');
		expect(h.currentId).toBe('b');
	});
	it('sends images as content parts and tool results in place of their blocks', () => {
		const { h, userId, replyId } = conversation();
		const withImage = updateMessage(h, userId, { files: [{ type: 'image', url: 'data:x' }] });
		const done = updateMessage(withImage, replyId, {
			content: 'A<details type="tool_calls" result="42">\n<summary>t</summary>\n</details>',
			done: true
		});
		expect(toApiMessages(messagesList(done, replyId))).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'hi' },
					{ type: 'image_url', image_url: { url: 'data:x' } }
				]
			},
			{ role: 'assistant', content: 'A42' }
		]);
	});
});

describe('replyColumns', () => {
	it('groups replies by model slot and selects the one on the current path', () => {
		const u = addUserMessage(emptyHistory(), null, { content: 'q', models: ['a', 'b'] });
		let { history: h } = addResponses(u.history, u.id, [{ id: 'a' }, { id: 'b' }]);
		const firstA = h.messages[u.id].childrenIds[0];
		h = addResponses(h, u.id, [{ id: 'a' }], 0).history;
		const cols = replyColumns({ ...h, currentId: firstA }, u.id);
		expect(cols.map((c) => [c.modelIdx, c.messageIds.length, c.selected])).toEqual([
			[0, 2, 0],
			[1, 1, 0]
		]);
	});
});

describe('editing a reply that has structured output (#211)', () => {
	// A streamed reply keeps what the model said in `output`, which the API
	// payload, actions and auto-copy prefer over `content`. An edit that
	// changed only `content` showed the correction while the model kept
	// receiving the original text.
	const output = [
		{ type: 'reasoning', id: 'r1', summary: [], content: [{ type: 'reasoning_text', text: 'six sevens' }] },
		{
			type: 'message',
			id: 'msg_1',
			role: 'assistant',
			status: 'completed',
			content: [{ type: 'output_text', text: 'The answer is 41.' }]
		}
	];
	const history = (): History => ({
		currentId: 'a',
		messages: {
			u: { id: 'u', parentId: null, childrenIds: ['a'], role: 'user', content: 'what is 6*7?' },
			a: {
				id: 'a',
				parentId: 'u',
				childrenIds: [],
				role: 'assistant',
				content: 'The answer is 41.',
				output: output as never,
				done: true
			}
		}
	});

	it('an edit reaches the output, and so the next request', () => {
		const edited = editContent(history(), 'a', 'The answer is 42.');
		expect(edited.messages.a.content).toBe('The answer is 42.');
		expect(edited.messages.a.originalContent).toBe('The answer is 41.');
		expect(getOutputText(edited.messages.a.output)).toBe('The answer is 42.');
		expect(JSON.stringify(toApiMessages(messagesList(edited, 'a')))).not.toContain('41');
	});

	it('Save As Copy gives the copy the edited output and leaves the original alone', () => {
		const h = history();
		const copied = saveReplyAsCopy(h, 'a', 'The answer is 42.');
		const copy = copied.messages[copied.currentId as string];
		expect(getOutputText(copy.output)).toBe('The answer is 42.');
		expect(JSON.stringify(toApiMessages(messagesList(copied, copy.id)))).not.toContain('41');
		expect(getOutputText(copied.messages.a.output)).toBe('The answer is 41.');
	});

	it('tool calls and code runs are kept, in order; only the text is replaced', () => {
		const h = history();
		const withTools = [
			{ type: 'reasoning', id: 'r1', content: [{ type: 'reasoning_text', text: 'compute it' }] },
			{ type: 'function_call', id: 'fc1', call_id: 'c1', name: 'calc', arguments: '{"x":6}' },
			{ type: 'function_call_output', id: 'fo1', call_id: 'c1', output: [{ type: 'input_text', text: '41' }] },
			{ type: 'open_webui:code_interpreter', id: 'ci1', code: 'print(6*7)', output: '42' },
			{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 41.' }] }
		];
		h.messages.a = { ...h.messages.a, output: withTools as never };
		const edited = editContent(h, 'a', 'The answer is 42.').messages.a.output ?? [];
		expect(edited.map((item) => item.type)).toEqual([
			'function_call',
			'function_call_output',
			'open_webui:code_interpreter',
			'message'
		]);
		expect(edited[3].id).toBe('msg_1');
		expect(getOutputText(edited)).toBe('The answer is 42.');
	});

	it('an edit to nothing leaves no empty message for the model', () => {
		const edited = editContent(history(), 'a', '   ');
		expect(edited.messages.a.output).toEqual([]);
		expect(toApiMessages(messagesList(edited, 'a')).filter((m) => m.role === 'assistant')).toEqual([]);
	});

	it('a reply without output is edited as before', () => {
		const h = history();
		h.messages.a = { ...h.messages.a, output: undefined };
		const edited = editContent(h, 'a', 'The answer is 42.');
		expect(edited.messages.a.output).toBeUndefined();
		expect(edited.messages.a.content).toBe('The answer is 42.');
	});
});
