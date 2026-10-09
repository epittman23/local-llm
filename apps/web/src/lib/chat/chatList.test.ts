import { describe, expect, it } from 'vitest';
import { chatAsText, descendantIds, fileSafe, folderTree, groupByTimeRange, isUnread } from './chatList';

describe('chat list', () => {
	it('is unread when updated after it was last read, never for the open chat', () => {
		expect(isUnread({ id: 'a', title: '', updated_at: 10, last_read_at: 5 }, null)).toBe(true);
		expect(isUnread({ id: 'a', title: '', updated_at: 10, last_read_at: 10 }, null)).toBe(false);
		expect(isUnread({ id: 'a', title: '', updated_at: 10 }, null)).toBe(true);
		expect(isUnread({ id: 'a', title: '', updated_at: 10 }, 'a')).toBe(false);
		expect(isUnread({ id: 'a', title: '', updated_at: 10, last_read_at: 1 }, null, 12)).toBe(false);
	});
	it('groups consecutive chats by time range', () => {
		const g = groupByTimeRange([
			{ id: '1', title: '', time_range: 'Today' },
			{ id: '2', title: '', time_range: 'Today' },
			{ id: '3', title: '', time_range: 'Yesterday' }
		]);
		expect(g.map((x) => [x.label, x.chats.length])).toEqual([
			['Today', 2],
			['Yesterday', 1]
		]);
	});
});

describe('folders', () => {
	const folders = [
		{ id: 'b', name: 'Beta' },
		{ id: 'a', name: 'Alpha' },
		{ id: 'a1', name: 'Child', parent_id: 'a' },
		{ id: 'a11', name: 'Grandchild', parent_id: 'a1' },
		{ id: 'o', name: 'Orphan', parent_id: 'gone' }
	];
	it('builds a sorted tree and keeps orphans at the top', () => {
		const t = folderTree(folders);
		expect(t.map((n) => n.name)).toEqual(['Alpha', 'Beta', 'Orphan']);
		expect(t[0].children[0].children[0].name).toBe('Grandchild');
	});
	it('knows a folder and its descendants', () => {
		expect([...descendantIds(folders, 'a')].sort()).toEqual(['a', 'a1', 'a11']);
	});
});

describe('export', () => {
	it('writes the current branch as text', () => {
		const chat = {
			chat: {
				history: {
					currentId: 'r2',
					messages: {
						u: { id: 'u', parentId: null, role: 'user', content: 'Hi' },
						r1: { id: 'r1', parentId: 'u', role: 'assistant', content: 'old' },
						r2: { id: 'r2', parentId: 'u', role: 'assistant', content: 'Hello' }
					}
				}
			}
		};
		expect(chatAsText(chat)).toBe('### USER\nHi\n\n### ASSISTANT\nHello');
	});
	it('makes titles file-safe', () => {
		expect(fileSafe('a/b:c?')).toBe('a_b_c_');
	});
});
