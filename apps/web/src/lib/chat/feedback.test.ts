import { describe, expect, it } from 'vitest';
import { annotate, feedbackItem } from './feedback';
import { addResponses, addUserMessage, canContinue, deleteMessage, editContent, emptyHistory, saveReplyAsCopy } from './history';

const setup = () => {
	const u = addUserMessage(emptyHistory(), null, { content: 'q' });
	const r = addResponses(u.history, u.id, [{ id: 'a' }, { id: 'b' }]);
	return { h: r.history, userId: u.id, replies: r.targets.map((t) => t.message_id) };
};

describe('editing and deleting', () => {
	it('keeps the original text of an edited reply', () => {
		const { h, replies } = setup();
		const done = editContent({ ...h, messages: { ...h.messages, [replies[0]]: { ...h.messages[replies[0]], content: 'old' } } }, replies[0], 'new');
		expect(done.messages[replies[0]]).toMatchObject({ content: 'new', originalContent: 'old' });
	});
	it('saves an edited reply as a new version', () => {
		const { h, userId, replies } = setup();
		const copy = saveReplyAsCopy(h, replies[0], 'better');
		expect(copy.messages[userId].childrenIds).toHaveLength(3);
		expect(copy.messages[copy.currentId!]).toMatchObject({ content: 'better', model: 'a', parentId: userId });
	});
	it('deletes a prompt with its replies and lifts what came after', () => {
		let { h, replies } = setup();
		const next = addUserMessage(h, replies[1], { content: 'follow-up' });
		h = next.history;
		const d = deleteMessage(h, replies[1]);
		expect(d.messages[replies[1]]).toBeUndefined();
		expect(d.messages[next.id]).toBeUndefined();
		const e = deleteMessage(h, Object.values(h.messages).find((m) => m.content === 'q')!.id);
		expect(Object.keys(e.messages)).toEqual([next.id]);
		expect(e.messages[next.id].parentId).toBeNull();
		expect(e.currentId).toBe(next.id);
	});
	it('offers continue only for a finished reply with text', () => {
		expect(canContinue({ id: 'x', parentId: null, childrenIds: [], role: 'assistant', content: 'part', done: true })).toBe(true);
		expect(canContinue({ id: 'x', parentId: null, childrenIds: [], role: 'assistant', content: '', done: true })).toBe(false);
	});
});

describe('feedback', () => {
	it('records the rating with sibling models and their base models', () => {
		const { h, replies } = setup();
		const m = h.messages[replies[0]];
		const item = feedbackItem({ history: h, message: m, annotation: annotate(m, 1), chatId: 'c1', chat: { id: 'c1' }, baseModelOf: (id) => (id === 'a' ? 'llama3' : null) });
		expect(item).toMatchObject({ type: 'rating', data: { rating: 1, model_id: 'a', sibling_model_ids: ['b'] }, meta: { chat_id: 'c1', message_id: m.id, message_index: 2, base_models: { a: 'llama3', b: null } } });
	});
	it('merges details into the annotation', () => {
		const { h, replies } = setup();
		const m = { ...h.messages[replies[0]], annotation: { rating: -1 } };
		expect(annotate(m, null, { reason: 'too_verbose', comment: 'long' })).toEqual({ rating: -1, reason: 'too_verbose', comment: 'long' });
	});
});
