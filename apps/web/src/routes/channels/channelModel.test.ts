import { describe, expect, it } from 'vitest';
import {
	type Channel,
	type ChannelEvent,
	type ChannelMessage,
	type ChannelUser,
	applyMessageEvent,
	applyTyping,
	applyUnreadEvent,
	attachmentUrl,
	channelPayload,
	channelTitle,
	closesThread,
	codeRanges,
	encodeMention,
	encodeMentions,
	isPublicChannel,
	markRead,
	mentionQuery,
	mentionsToText,
	reactionTooltip,
	showsAuthor,
	sortChannels,
	toggleReaction
} from './channelModel';

const msg = (id: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
	id,
	content: id,
	user_id: 'u1',
	user: { id: 'u1', name: 'Ann' },
	created_at: 1,
	updated_at: 1,
	...extra
});
const ev = (type: string, data: any, extra: Partial<ChannelEvent> = {}): ChannelEvent => ({
	channel_id: 'c1',
	data: { type, data },
	...extra
});
const inChannel = { channelId: 'c1', parentId: null };
const inThread = { channelId: 'c1', parentId: 'root' };
const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe('applyMessageEvent', () => {
	it('adds a new message at the front, replacing the optimistic copy by temp_id', () => {
		const list = [msg('tmp', { temp_id: 't1' }), msg('a')];
		const next = applyMessageEvent(list, ev('message', msg('b', { temp_id: 't1' })), inChannel);
		expect(ids(next)).toEqual(['b', 'a']);
		expect(next[0].temp_id).toBeNull();
	});
	it('does not duplicate a message it already has', () => {
		expect(ids(applyMessageEvent([msg('a')], ev('message', msg('a')), inChannel))).toEqual(['a']);
	});
	it('keeps thread replies out of the channel, and channel messages out of a thread', () => {
		const reply = msg('r', { parent_id: 'root' });
		expect(applyMessageEvent([msg('a')], ev('message', reply), inChannel)).toHaveLength(1);
		expect(applyMessageEvent([], ev('message', reply), inThread)).toHaveLength(1);
		expect(applyMessageEvent([], ev('message', msg('x')), inThread)).toHaveLength(0);
	});
	it('only events for its own channel count', () => {
		const list = [msg('a')];
		for (const type of ['message', 'message:update', 'message:delete', 'message:reaction:add']) {
			expect(
				applyMessageEvent(list, ev(type, msg(type === 'message' ? 'z' : 'a'), { channel_id: 'other' }), inChannel)
			).toBe(list);
		}
	});
	it('updates, deletes and applies reactions in place', () => {
		const list = [msg('a'), msg('b')];
		expect(applyMessageEvent(list, ev('message:update', msg('a', { content: 'edited' })), inChannel)[0].content).toBe(
			'edited'
		);
		const reacted = applyMessageEvent(
			list,
			ev('message:reaction:add', msg('b', { reactions: [{ name: 'tada', users: [], count: 0 }] })),
			inChannel
		);
		expect(reacted[1].reactions).toHaveLength(1);
		expect(reacted[0]).toBe(list[0]);
		expect(applyMessageEvent(list, ev('message:reply', msg('a', { reply_count: 2 })), inChannel)[0].reply_count).toBe(
			2
		);
		expect(ids(applyMessageEvent(list, ev('message:delete', { id: 'a' }), inChannel))).toEqual(['b']);
	});
	it('merges an update; a pin sending data as `true` keeps the loaded attachments', () => {
		const loaded = { files: [{ id: 'f1', name: 'a.pdf' }] };
		const list = [msg('a', { data: loaded })];
		const pinned = applyMessageEvent(
			list,
			ev('message:update', { id: 'a', content: 'a', is_pinned: true, data: true }),
			inChannel
		);
		expect(pinned[0]).toMatchObject({ is_pinned: true, data: loaded, user: { id: 'u1' } });
		expect(
			applyMessageEvent(list, ev('message:update', { id: 'a', content: 'a', data: false }), inChannel)[0].data
		).toBe(false);
		expect(
			applyMessageEvent(list, ev('message:update', { id: 'a', content: 'new', data: { files: [] } }), inChannel)[0]
		).toMatchObject({ content: 'new', data: { files: [] } });
	});
	it('an edit or delete reaches the quotes of that message', () => {
		const list = [msg('b', { reply_to_message: msg('x') }), msg('x')];
		const edited = applyMessageEvent(
			list,
			ev('message:update', msg('x', { content: 'fixed', updated_at: 2 })),
			inChannel
		);
		expect(edited[0].reply_to_message).toMatchObject({ content: 'fixed', updated_at: 2, user: { id: 'u1' } });
		expect(applyMessageEvent(list, ev('message:update', msg('x', { is_pinned: true })), inChannel)[0]).toBe(list[0]);
		const deleted = applyMessageEvent(list, ev('message:delete', msg('x')), inChannel);
		expect(ids(deleted)).toEqual(['b']);
		expect(deleted[0].reply_to_message).toBeNull();
	});
	it('returns the same array when nothing in it changed', () => {
		const list = [msg('a')];
		for (const type of [
			'message:update',
			'message:reply',
			'message:reaction:add',
			'message:reaction:remove',
			'message:delete',
			'last_read_at'
		]) {
			expect(applyMessageEvent(list, ev(type, msg('elsewhere')), inChannel)).toBe(list);
		}
		expect(applyMessageEvent(list, ev('typing', { typing: true }), inChannel)).toBe(list);
		expect(applyMessageEvent(list, ev('message:update', undefined), inChannel)).toBe(list);
	});
	it('deleting the root closes its thread', () => {
		const del = ev('message:delete', msg('root'));
		expect(closesThread(del, inThread)).toBe(true);
		expect(ids(applyMessageEvent([msg('r2'), msg('root')], del, inThread))).toEqual(['r2']);
		expect(closesThread(ev('message:delete', msg('r2')), inThread)).toBe(false);
		expect(closesThread({ ...del, channel_id: 'other' }, inThread)).toBe(false);
		expect(closesThread(del, inChannel)).toBe(false);
		expect(closesThread(ev('message:update', msg('root')), inThread)).toBe(false);
	});
});

describe('applyTyping', () => {
	const ann: ChannelUser = { id: 'u2', name: 'Ann' };
	const bob: ChannelUser = { id: 'u3', name: 'Bob' };
	const typing = (user: ChannelUser, on = true, message_id: string | null = null, channel_id = 'c1'): ChannelEvent => ({
		channel_id,
		message_id,
		user,
		data: { type: 'typing', data: { typing: on } }
	});

	it('adds someone once, removes them, and never shows yourself', () => {
		let t = applyTyping([], typing(ann), inChannel, 'me');
		t = applyTyping(t, typing(ann), inChannel, 'me');
		expect(t).toEqual([ann]);
		expect(applyTyping(t, typing(ann, false), inChannel, 'me')).toEqual([]);
		expect(applyTyping([], typing({ id: 'me', name: 'Me' }), inChannel, 'me')).toEqual([]);
	});
	it('keeps the order, and the array, while people keep typing', () => {
		const both = applyTyping(applyTyping([], typing(ann), inChannel, 'me'), typing(bob), inChannel, 'me');
		expect(ids(both)).toEqual(['u2', 'u3']);
		expect(applyTyping(both, typing(ann), inChannel, 'me')).toBe(both);
	});
	it('counts only typing in the same channel and thread', () => {
		expect(applyTyping([], typing(ann, true, 'root'), inChannel, 'me')).toEqual([]);
		expect(applyTyping([], typing(ann, true, null), inThread, 'me')).toEqual([]);
		expect(applyTyping([], typing(ann, true, null, 'other'), inChannel, 'me')).toEqual([]);
		expect(applyTyping([], typing(ann, true, 'root'), inThread, 'me')).toEqual([ann]);
	});
	it("the typer's own message landing clears them; other events do not", () => {
		const list = [ann, bob];
		expect(ids(applyTyping(list, ev('message', msg('m'), { user: ann }), inChannel, 'me'))).toEqual(['u3']);
		expect(
			ids(applyTyping(list, ev('message', msg('m', { parent_id: 'root' }), { user: ann }), inThread, 'me'))
		).toEqual(['u3']);
		expect(applyTyping(list, ev('message', msg('m', { parent_id: 'root' }), { user: ann }), inChannel, 'me')).toBe(
			list
		);
		expect(
			applyTyping(list, ev('message', msg('m', { meta: { model_id: 'gpt' } }), { user: ann }), inChannel, 'me')
		).toBe(list);
		expect(applyTyping(list, ev('message:reaction:add', msg('m'), { user: ann }), inChannel, 'me')).toBe(list);
		expect(applyTyping(list, ev('message:update', msg('m'), { user: bob }), inChannel, 'me')).toBe(list);
	});
});

describe('toggleReaction', () => {
	const me = { id: 'me', name: 'Me' };
	it('adds a new reaction, joins an existing one, and removes an emptied one', () => {
		const added = toggleReaction(msg('a'), 'tada', me);
		expect(added.added).toBe(true);
		expect(added.message.reactions).toEqual([{ name: 'tada', users: [me], count: 1 }]);
		const joined = toggleReaction(
			msg('a', { reactions: [{ name: 'tada', users: [{ id: 'x' }], count: 1 }] }),
			'tada',
			me
		);
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
	it('starts a block at the oldest message, for a new author or model, or a reply (list newest-first)', () => {
		const bob = { user_id: 'u2', user: { id: 'u2', name: 'Bob' } };
		const gpt = { meta: { model_id: 'gpt' } };
		const list = [
			msg('e', { ...bob, ...gpt, reply_to_message: msg('a') }),
			msg('d', { ...bob, ...gpt }),
			msg('c', bob),
			msg('b'),
			msg('a')
		];
		expect(list.map((_, i) => showsAuthor(list, i))).toEqual([true, true, true, false, true]);
	});
	it('names a DM by its other members', () => {
		expect(
			channelTitle(
				{
					name: '',
					type: 'dm',
					users: [
						{ id: 'me', name: 'Me' },
						{ id: 'b', name: 'Bob' }
					]
				},
				'me'
			)
		).toBe('Bob');
		expect(channelTitle({ name: 'general' }, 'me')).toBe('general');
	});
});

describe('mentions', () => {
	const sam = { kind: 'user', id: 'sam', label: 'Sam' } as const;
	const gpt = { kind: 'model', id: 'gpt', label: 'GPT' } as const;
	const gpt4o = { kind: 'model', id: 'gpt-4o', label: 'GPT-4o' } as const;

	it('encodes only the mentions still in the text; channels with #', () => {
		const text = encodeMentions('hi @Ann and @gpt in #general', [
			{ kind: 'channel', id: 'c1', label: 'general' },
			{ kind: 'user', id: 'u1', label: 'Ann' },
			{ kind: 'model', id: 'gpt-4', label: 'gpt' },
			{ kind: 'user', id: 'u9', label: 'Gone' }
		]);
		expect(text).toBe('hi <@U:u1|Ann> and <@M:gpt-4|gpt> in <#C:c1|general>');
		expect(encodeMentions('see @general', [{ kind: 'channel', id: 'c1', label: 'general' }])).toBe('see @general');
	});
	it('a label cannot end the tag early, and an emptied label is left out', () => {
		expect(encodeMention({ kind: 'user', id: 'u', label: 'a>b|c' })).toBe('<@U:u|abc>');
		expect(encodeMention({ kind: 'model', id: 'm1', label: '|' })).toBe('<@M:m1>');
	});
	it('encodes a mention only as a whole word, every time it appears', () => {
		expect(encodeMentions('cc @Samantha and @Sam', [sam])).toBe('cc @Samantha and <@U:sam|Sam>');
		expect(encodeMentions('hi @Sam, @Sam. @Sam!', [sam])).toBe('hi <@U:sam|Sam>, <@U:sam|Sam>. <@U:sam|Sam>!');
		expect(encodeMentions('mail x@Sam', [sam])).toBe('mail x@Sam');
		expect(encodeMentions('hi @Ann Lee!', [{ kind: 'user', id: 'al', label: 'Ann Lee' }])).toBe('hi <@U:al|Ann Lee>!');
	});
	it('a longer label claims its text before a shorter one it starts with', () => {
		expect(encodeMentions('@GPT-4o and @GPT hi', [gpt, gpt4o])).toBe('<@M:gpt-4o|GPT-4o> and <@M:gpt|GPT> hi');
		expect(encodeMentions('@GPT-4o only', [gpt])).toBe('@GPT-4o only');
	});
	it('never matches inside a tag it produced', () => {
		expect(
			encodeMentions('@Bob and @U', [
				{ kind: 'user', id: 'b', label: 'Bob' },
				{ kind: 'user', id: 'u2', label: 'U' }
			])
		).toBe('<@U:b|Bob> and <@U:u2|U>');
	});
	it('finds the word being typed after an @ or #, in any script', () => {
		expect(mentionQuery('hello @an', 9)).toEqual({ trigger: '@', query: 'an', start: 6 });
		expect(mentionQuery('see #gen', 8)).toEqual({ trigger: '#', query: 'gen', start: 4 });
		expect(mentionQuery('@', 1)).toEqual({ trigger: '@', query: '', start: 0 });
		expect(mentionQuery('hi @José', 8)?.query).toBe('José');
		expect(mentionQuery('hi @张', 5)?.query).toBe('张');
		expect(mentionQuery("hi @O'Brien", 11)?.query).toBe("O'Brien");
		expect(mentionQuery('@Jo hi', 3)?.query).toBe('Jo');
	});
	it('not inside a word, and not once a space ends it', () => {
		expect(mentionQuery('mail@host', 9)).toBeNull();
		expect(mentionQuery('hi @Jo ', 7)).toBeNull();
	});
	it('gives same-label mentions their occurrences in the order they were inserted', () => {
		const a = { kind: 'user', id: 'john-a', label: 'John Smith' } as const;
		const b = { kind: 'user', id: 'john-b', label: 'John Smith' } as const;
		expect(encodeMentions('@John Smith and @John Smith', [a, b])).toBe(
			'<@U:john-a|John Smith> and <@U:john-b|John Smith>'
		);
		expect(encodeMentions('@John Smith, @John Smith, @John Smith', [b, a])).toBe(
			'<@U:john-b|John Smith>, <@U:john-a|John Smith>, <@U:john-a|John Smith>'
		);
		// The same person inserted twice is still one target for every occurrence.
		expect(encodeMentions('@Sam @Sam @Sam', [sam, sam])).toBe('<@U:sam|Sam> <@U:sam|Sam> <@U:sam|Sam>');
	});
	it('a name run straight into text written without spaces is still a mention', () => {
		expect(encodeMentions('@GPT-4o帮我翻译一下', [gpt4o])).toBe('<@M:gpt-4o|GPT-4o>帮我翻译一下');
		const zhang = { kind: 'user', id: 'z3', label: '张三' } as const;
		expect(encodeMentions('你好@张三你看一下', [zhang])).toBe('你好<@U:z3|张三>你看一下');
		expect(encodeMentions('@Samの件', [sam])).toBe('<@U:sam|Sam>の件');
	});
	it('reads the neighbouring characters whole, even outside the Basic Multilingual Plane', () => {
		expect(encodeMentions('\u{1D400}@Sam', [sam])).toBe('\u{1D400}@Sam');
		expect(encodeMentions('@Sam\u{1D400}', [sam])).toBe('@Sam\u{1D400}');
		expect(encodeMentions('🎉@Sam 🎉', [sam])).toBe('🎉<@U:sam|Sam> 🎉');
	});
	it('leaves mentions inside code alone', () => {
		expect(encodeMentions('ping @Sam, run `notify @Sam` please', [sam])).toBe(
			'ping <@U:sam|Sam>, run `notify @Sam` please'
		);
		expect(encodeMentions('@Sam\n```\n@Sam\n```\n@Sam', [sam])).toBe('<@U:sam|Sam>\n```\n@Sam\n```\n<@U:sam|Sam>');
		expect(encodeMentions('an unclosed ` before @Sam', [sam])).toBe('an unclosed ` before <@U:sam|Sam>');
	});
	it('finds fenced blocks and inline code spans', () => {
		expect(codeRanges('a `b` c ``d`e`` f')).toEqual([
			[2, 5],
			[8, 15]
		]);
		expect(codeRanges('x\n~~~\ncode\n~~~\ny')).toEqual([[2, 14]]);
		expect(codeRanges('x\n```js\nopen to the end')).toEqual([[2, 23]]);
		expect(codeRanges('no \\`escape` here')).toEqual([]);
	});
	it('turns mention tags into plain text for previews and notifications', () => {
		expect(mentionsToText('hi <@U:u1|Ann> in <#C:c1|general>, <@M:gpt-4o> and <@C:c2|old>')).toBe(
			'hi @Ann in #general, @gpt-4o and #old'
		);
	});
});

describe('the channel list', () => {
	const ch = (id: string, type: string | null, extra: Partial<Channel> = {}): Channel => ({
		id,
		name: id,
		type,
		created_at: 1,
		...extra
	});

	it('sorts standard, group, then DM channels', () => {
		expect(sortChannels([ch('d', 'dm'), ch('g', 'group'), ch('s', null), ch('e', '')]).map((c) => c.id)).toEqual([
			'e',
			's',
			'g',
			'd'
		]);
	});
	it('reads public from a group flag, else from a public read grant', () => {
		expect(isPublicChannel({ type: 'group', is_private: false })).toBe(true);
		expect(
			isPublicChannel({
				type: 'group',
				is_private: true,
				access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }]
			})
		).toBe(false);
		expect(
			isPublicChannel({ type: '', access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] })
		).toBe(true);
		expect(isPublicChannel({ type: '' })).toBe(false);
	});
	it('counts unread messages from others in channels that are not open', () => {
		const list = [ch('c1', ''), ch('c2', '')];
		const message = (channel_id: string, userId: string) => ({
			channel_id,
			user: { id: userId, name: 'x' },
			data: { type: 'message', data: {} }
		});
		expect(applyUnreadEvent(list, message('c1', 'u2'), null, 'me')?.[0].unread_count).toBe(1);
		expect(applyUnreadEvent(list, message('c1', 'u2'), 'c1', 'me')).toBe(list);
		expect(applyUnreadEvent(list, message('c1', 'me'), null, 'me')).toBe(list);
		expect(applyUnreadEvent(list, message('c9', 'u2'), null, 'me')).toBeNull();
		expect(applyUnreadEvent(list, { channel_id: 'c1', data: { type: 'channel:created' } }, null, 'me')).toBeNull();
		expect(markRead([ch('c1', '', { unread_count: 3 })], 'c1')[0].unread_count).toBe(0);
	});
});

describe('channelPayload', () => {
	const base = {
		type: '' as const,
		name: 'My Channel',
		isPrivate: true,
		accessGrants: [{ principal_type: 'group', principal_id: 'g1', permission: 'read' }],
		userIds: []
	};
	it('normalises the name and keeps grants only for a standard channel', () => {
		const r = channelPayload(base);
		expect('payload' in r && r.payload).toMatchObject({
			name: 'my-channel',
			is_private: null,
			access_grants: base.accessGrants
		});
		const g = channelPayload({ ...base, type: 'group' });
		expect('payload' in g && g.payload).toMatchObject({ is_private: true, access_grants: [] });
	});
	it('requires a name, except for a DM, which requires members', () => {
		expect(channelPayload({ ...base, name: '  ' })).toEqual({ error: 'Channel name cannot be empty.' });
		expect(channelPayload({ ...base, type: 'dm', name: '' })).toEqual({
			error: 'Please select at least one user for Direct Message channel.'
		});
		expect('payload' in channelPayload({ ...base, type: 'dm', name: '', userIds: ['u2'] })).toBe(true);
		expect(channelPayload({ ...base, name: 'x'.repeat(129) })).toEqual({
			error: 'Channel name must be less than 128 characters'
		});
	});
});

describe('display helpers', () => {
	it('lists up to three names, then the rest as a count', () => {
		const users = ['me', 'a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
		expect(reactionTooltip({ name: 'tada', users: users.slice(0, 2), count: 2 }, 'me')).toBe(
			'You and A reacted with :tada:'
		);
		expect(reactionTooltip({ name: 'tada', users, count: 5 }, 'me')).toBe(
			'You, A and B and 2 others reacted with :tada:'
		);
	});
	it('builds attachment URLs', () => {
		expect(attachmentUrl({ url: 'f1', content_type: 'image/png' }, '/api/v1')).toBe('/api/v1/files/f1/content');
		expect(attachmentUrl({ url: 'https://x/y.png' }, '/api/v1')).toBe('https://x/y.png');
	});
});
