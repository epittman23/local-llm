import { describe, expect, it } from 'vitest';
import {
	applyUnreadEvent,
	encodeMentions,
	reactionTooltip
} from '@/routes/channels/channelModel';

describe('F7 channelModel probes', () => {
	it('a thread reply bumps the sidebar unread count (the server count excludes replies)', () => {
		const list = [{ id: 'c1', name: 'general', type: '', created_at: 1, unread_count: 0 }];
		const reply = {
			channel_id: 'c1',
			user: { id: 'u2', name: 'Bob' },
			data: { type: 'message', data: { id: 'r1', parent_id: 'root1', content: 'in thread' } }
		};
		const next = applyUnreadEvent(list, reply, null, 'me');
		console.log('unread after thread reply:', next?.[0].unread_count);
		expect(next?.[0].unread_count).toBe(1);
	});

	it('reaction tooltip with exactly four reactors names three and drops the fourth', () => {
		const users = ['me', 'a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }));
		const s = reactionTooltip({ name: 'tada', users, count: 4 }, 'me');
		console.log('4 reactors:', s);
		expect(s).toBe('You, A and B reacted with :tada:');
	});

	it('mention edge cases', () => {
		const sam = { kind: 'user', id: 'sam', label: 'Sam' } as const;
		console.log(JSON.stringify(encodeMentions('hi @Sam.how', [sam])));
	});
});
