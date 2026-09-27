import { describe, expect, it } from 'vitest';
import {
	type Channel,
	type ChannelMessage,
	applyMessageEvent,
	applyTyping,
	applyUnreadEvent,
	attachmentUrl,
	channelPayload,
	channelTitle,
	encodeMentions,
	isPublicChannel,
	markRead,
	mentionQuery,
	reactionTooltip,
	renderMentions,
	showsAuthor,
	sortChannels,
	toggleReaction
} from './channelModel';

const msg = (id: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({ id, content: id, user_id: 'u1', user: { id: 'u1', name: 'Ann' }, created_at: 1, updated_at: 1, ...extra });
const ev = (type: string, data: any, extra: Record<string, unknown> = {}) => ({ channel_id: 'c1', data: { type, data }, ...extra });

describe('applyMessageEvent', () => {
	it('adds a new message at the front, replacing the optimistic copy by temp_id', () => {
		const list = [msg('tmp', { temp_id: 't1' }), msg('a')];
		const next = applyMessageEvent(list, ev('message', msg('b', { temp_id: 't1' })));
		expect(next.map((m) => m.id)).toEqual(['b', 'a']);
		expect(next[0].temp_id).toBeNull();
	});
	it('does not duplicate a message it already has', () => {
		expect(applyMessageEvent([msg('a')], ev('message', msg('a'))).map((m) => m.id)).toEqual(['a']);
	});
	it('keeps thread replies out of the channel, and channel messages out of a thread', () => {
		const reply = msg('r', { parent_id: 'root' });
		expect(applyMessageEvent([msg('a')], ev('message', reply))).toHaveLength(1);
		expect(applyMessageEvent([], ev('message', reply), 'root')).toHaveLength(1);
		expect(applyMessageEvent([], ev('message', msg('x')), 'root')).toHaveLength(0);
	});
	it('updates, deletes and applies reactions in place', () => {
		const list = [msg('a'), msg('b')];
		expect(applyMessageEvent(list, ev('message:update', msg('a', { content: 'edited' })))[0].content).toBe('edited');
		expect(applyMessageEvent(list, ev('message:reaction:add', msg('b', { reactions: [{ name: 'tada', users: [], count: 0 }] })))[1].reactions).toHaveLength(1);
		expect(applyMessageEvent(list, ev('message:delete', { id: 'a' })).map((m) => m.id)).toEqual(['b']);
	});
	it('ignores events it does not know', () => {
		const list = [msg('a')];
		expect(applyMessageEvent(list, ev('typing', { typing: true }))).toBe(list);
	});
});

describe('applyTyping', () => {
	it('adds someone once, removes them, and never shows yourself', () => {
		const ann = { id: 'u2', name: 'Ann' };
		let t = applyTyping([], { channel_id: 'c1', user: ann, data: { type: 'typing', data: { typing: true } } }, 'me');
		t = applyTyping(t, { channel_id: 'c1', user: ann, data: { type: 'typing', data: { typing: true } } }, 'me');
		expect(t).toEqual([ann]);
		expect(applyTyping(t, { channel_id: 'c1', user: ann, data: { type: 'typing', data: { typing: false } } }, 'me')).toEqual([]);
		expect(applyTyping([], { channel_id: 'c1', user: { id: 'me', name: 'Me' }, data: { data: { typing: true } } }, 'me')).toEqual([]);
	});
});

describe('toggleReaction', () => {
	const me = { id: 'me', name: 'Me' };
	it('adds a new reaction, joins an existing one, and removes an emptied one', () => {
		const added = toggleReaction(msg('a'), 'tada', me);
		expect(added.added).toBe(true);
		expect(added.message.reactions).toEqual([{ name: 'tada', users: [me], count: 1 }]);
		const joined = toggleReaction(msg('a', { reactions: [{ name: 'tada', users: [{ id: 'x' }], count: 1 }] }), 'tada', me);
		expect(joined.message.reactions?.[0].count).toBe(2);
		const removed = toggleReaction(added.message, 'tada', me);
		expect(removed.added).toBe(false);
		expect(removed.message.reactions).toEqual([]);
	});
	it('does not mutate the message it was given', () => {
		const original = msg('a', { reactions: [{ name: 'tada', users: [{ id: 'x' }], count: 1 }] });
		toggleReaction(original, 'tada', me);
		expect(original.reactions?.[0].users).toHaveLength(1);
	});
});

describe('showsAuthor and titles', () => {
	it('starts a block for a new author, a model, or a reply', () => {
		const list = [msg('a'), msg('b'), msg('c', { user_id: 'u2', user: { id: 'u2', name: 'Bob' } }), msg('d', { user_id: 'u2', user: { id: 'u2', name: 'Bob' }, reply_to_message: msg('a') })];
		expect(list.map((_, i) => showsAuthor(list, i))).toEqual([true, false, true, true]);
	});
	it('names a DM by its other members', () => {
		expect(channelTitle({ name: '', type: 'dm', users: [{ id: 'me', name: 'Me' }, { id: 'b', name: 'Bob' }] }, 'me')).toBe('Bob');
		expect(channelTitle({ name: 'general' }, 'me')).toBe('general');
	});
});

describe('mentions', () => {
	it('encodes only the mentions still in the text', () => {
		const text = encodeMentions('hi @Ann and @gpt in #general', [
			{ kind: 'channel', id: 'c1', label: 'general' },
			{ kind: 'user', id: 'u1', label: 'Ann' },
			{ kind: 'model', id: 'gpt-4', label: 'gpt' },
			{ kind: 'user', id: 'u9', label: 'Gone' }
		]);
		expect(text).toBe('hi <@U:u1|Ann> and <@M:gpt-4|gpt> in <@C:c1|general>');
	});
	it('finds the word being typed after an @', () => {
		expect(mentionQuery('hello @an', 9)).toEqual({ trigger: '@', query: 'an', start: 6 });
		expect(mentionQuery('see #gen', 8)).toEqual({ trigger: '#', query: 'gen', start: 4 });
		expect(mentionQuery('mail@host', 9)).toBeNull();
	});
	it('renders mentions as escaped spans', () => {
		expect(renderMentions('hi <@U:u1|Ann> in <@C:c1|general>')).toBe('hi <span class="mention" data-kind="U">@Ann</span> in <span class="mention" data-kind="C">#general</span>');
		expect(renderMentions('<@U:u1|<b>x</b>>')).not.toContain('<b>');
	});
});

describe('the channel list', () => {
	const ch = (id: string, type: string | null, extra: Partial<Channel> = {}): Channel => ({ id, name: id, type, created_at: 1, ...extra });

	it('sorts standard, group, then DM channels', () => {
		expect(sortChannels([ch('d', 'dm'), ch('g', 'group'), ch('s', null), ch('e', '')]).map((c) => c.id)).toEqual(['e', 's', 'g', 'd']);
	});
	it('reads public from a group flag, else from a public read grant', () => {
		expect(isPublicChannel({ type: 'group', is_private: false })).toBe(true);
		expect(isPublicChannel({ type: 'group', is_private: true, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] })).toBe(false);
		expect(isPublicChannel({ type: '', access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] })).toBe(true);
		expect(isPublicChannel({ type: '' })).toBe(false);
	});
	it('counts unread messages from others in channels that are not open', () => {
		const list = [ch('c1', ''), ch('c2', '')];
		const message = (channel_id: string, userId: string) => ({ channel_id, user: { id: userId, name: 'x' }, data: { type: 'message', data: {} } });
		expect(applyUnreadEvent(list, message('c1', 'u2'), null, 'me')?.[0].unread_count).toBe(1);
		expect(applyUnreadEvent(list, message('c1', 'u2'), 'c1', 'me')).toBe(list);
		expect(applyUnreadEvent(list, message('c1', 'me'), null, 'me')).toBe(list);
		expect(applyUnreadEvent(list, message('c9', 'u2'), null, 'me')).toBeNull();
		expect(applyUnreadEvent(list, { channel_id: 'c1', data: { type: 'channel:created' } }, null, 'me')).toBeNull();
		expect(markRead([ch('c1', '', { unread_count: 3 })], 'c1')[0].unread_count).toBe(0);
	});
});

describe('channelPayload', () => {
	const base = { type: '' as const, name: 'My Channel', isPrivate: true, accessGrants: [{ principal_type: 'group', principal_id: 'g1', permission: 'read' }], userIds: [] };
	it('normalises the name and keeps grants only for a standard channel', () => {
		const r = channelPayload(base);
		expect('payload' in r && r.payload).toMatchObject({ name: 'my-channel', is_private: null, access_grants: base.accessGrants });
		const g = channelPayload({ ...base, type: 'group' });
		expect('payload' in g && g.payload).toMatchObject({ is_private: true, access_grants: [] });
	});
	it('requires a name, except for a DM, which requires members', () => {
		expect(channelPayload({ ...base, name: '  ' })).toEqual({ error: 'Channel name cannot be empty.' });
		expect(channelPayload({ ...base, type: 'dm', name: '' })).toEqual({ error: 'Please select at least one user for Direct Message channel.' });
		expect('payload' in channelPayload({ ...base, type: 'dm', name: '', userIds: ['u2'] })).toBe(true);
		expect(channelPayload({ ...base, name: 'x'.repeat(129) })).toEqual({ error: 'Channel name must be less than 128 characters' });
	});
});

describe('display helpers', () => {
	it('lists up to three names, then the rest as a count', () => {
		const users = ['me', 'a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
		expect(reactionTooltip({ name: 'tada', users: users.slice(0, 2), count: 2 }, 'me')).toBe('You and A reacted with :tada:');
		expect(reactionTooltip({ name: 'tada', users, count: 5 }, 'me')).toBe('You, A and B and 2 others reacted with :tada:');
	});
	it('builds attachment URLs', () => {
		expect(attachmentUrl({ url: 'f1', content_type: 'image/png' }, '/api/v1')).toBe('/api/v1/files/f1/content');
		expect(attachmentUrl({ url: 'https://x/y.png' }, '/api/v1')).toBe('https://x/y.png');
	});
});
