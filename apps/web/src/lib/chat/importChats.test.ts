import { describe, expect, it } from 'vitest';
import { importPayload, parseChatExport } from './importChats';

const chatgpt = [
	{
		id: 'x',
		title: 'Trip',
		create_time: 1700000000.5,
		mapping: {
			root: { message: null, children: ['s'] },
			s: { message: { author: { role: 'system' }, content: { parts: [''] } }, children: ['u'] },
			u: { message: { author: { role: 'user' }, content: { parts: ['Plan a trip'] }, create_time: 1700000001 }, children: ['a'] },
			a: { message: { author: { role: 'assistant' }, content: { parts: ['Sure'] }, metadata: { model_slug: 'gpt-4o' } }, children: ['t'] },
			t: { message: { author: { role: 'tool' }, content: { text: 'x' } }, children: [] }
		}
	},
	{ id: 'folder', title: 'A project' }
];

describe('chat import', () => {
	it('converts a ChatGPT export and skips folders, system and tool messages', () => {
		const [chat, ...rest] = parseChatExport(JSON.stringify(chatgpt));
		expect(rest).toEqual([]);
		expect(chat.chat.messages.map((m: any) => [m.role, m.content])).toEqual([['user', 'Plan a trip'], ['assistant', 'Sure']]);
		expect(chat.chat.history.currentId).toBe('a');
		expect(chat.chat.models).toEqual(['gpt-4o']);
		expect(chat.created_at).toBe(1700000000);
	});
	it('passes this app’s export through and unpins everything', () => {
		const own = [{ id: 'c', chat: { title: 'T' }, pinned: true, folder_id: 'f', created_at: 5 }];
		expect(importPayload(parseChatExport(JSON.stringify(own)))).toEqual([{ chat: { title: 'T' }, meta: {}, pinned: false, folder_id: 'f', created_at: 5, updated_at: null }]);
	});
	it('rejects what is not a list', () => {
		expect(() => parseChatExport('{"a":1}')).toThrow();
	});
});
