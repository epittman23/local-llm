import { expect, test } from 'bun:test';
import { normalizeHistory, isGenerating, showBranch } from '../../../../apps/web/src/lib/chat/history';
test('non-current stale reply stays not-done', () => {
  const raw = { currentId: 'b', messages: {
    u: { id: 'u', parentId: null, childrenIds: ['a','b'], role: 'user', content: 'hi' },
    a: { id: 'a', parentId: 'u', childrenIds: [], role: 'assistant', content: 'partial', done: false },
    b: { id: 'b', parentId: 'u', childrenIds: [], role: 'assistant', content: 'ok', done: true } } } as any;
  const h = normalizeHistory(raw);
  expect(h.messages.a.done).toBe(false);
  expect(isGenerating(showBranch(h, 'a'))).toBe(true);
});
