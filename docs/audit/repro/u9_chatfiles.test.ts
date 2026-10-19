import { describe, expect, it } from 'vitest';
import { addResponses, addUserMessage, emptyHistory } from '../../../apps/web/src/lib/chat/history';
import { completionBody } from '../../../apps/web/src/lib/chat/request';
describe('chatFiles pruning', () => {
  it('sends a doc whose message is no longer on the path', () => {
    const X = { type: 'file', id: 'X', name: 'x.pdf', content_type: 'application/pdf' };
    // Branch B: a user message with no files (its sibling, which had X, was deleted or switched away)
    let { history: h, id } = addUserMessage(emptyHistory(), null, { content: 'hi', files: [], models: ['a'] });
    const r = addResponses(h, id, [{ id: 'a' }] as any);
    const body = completionBody({ history: r.history, responseId: r.targets[0].message_id, model: { id: 'a' }, chatId: 'c1', temporary: false, params: {}, settings: {}, chatFiles: [X], features: {}, variables: {} });
    expect(body.files).toEqual([X]); // Svelte: chatFiles filtered to files of _messages -> undefined
  });
});
