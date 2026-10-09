// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	addResponses,
	addUserMessage,
	applyChatEvent,
	emptyHistory,
	isGenerating,
	messagesList,
	normalizeHistory,
	replyColumns,
	showBranch,
	siblingsOf,
	toApiMessages,
	updateMessage
} from './history';

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
