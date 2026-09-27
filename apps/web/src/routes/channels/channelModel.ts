// The rules behind a channel (components/channel/*.svelte): applying the
// live `events:channel` socket events to a message list, optimistic
// reactions, who is typing, the mention encoding, and when a message shows
// its author. Messages are kept newest-first, as the API returns them.

export type Reaction = { name: string; users: { id: string; name?: string }[]; count: number };
export type ChannelUser = { id: string; name: string; role?: string; is_active?: boolean };
export type ChannelMessage = {
	id: string;
	temp_id?: string | null;
	channel_id?: string;
	parent_id?: string | null;
	user_id?: string;
	user?: ChannelUser | null;
	content: string;
	data?: { files?: { id?: string | null; name?: string; url?: string; type?: string; content_type?: string }[] } | true | null;
	meta?: { model_id?: string; model_name?: string } | null;
	reactions?: Reaction[];
	reply_count?: number;
	latest_reply_at?: number | null;
	reply_to_message?: ChannelMessage | null;
	is_pinned?: boolean;
	pinned_by?: string | null;
	pinned_at?: number | null;
	created_at: number;
	updated_at: number;
};
export type Channel = {
	id: string;
	name: string;
	type?: string | null;
	is_private?: boolean | null;
	write_access?: boolean;
	user_count?: number;
	users?: ChannelUser[];
	created_at: number;
	user_id?: string;
	access_grants?: { principal_type?: string; principal_id?: string; permission?: string }[];
	user_ids?: string[];
	is_manager?: boolean;
	unread_count?: number;
	last_message_at?: number | null;
};
export type ChannelEvent = {
	channel_id: string;
	message_id?: string | null;
	user?: ChannelUser;
	channel?: Pick<Channel, 'name' | 'type'>;
	created_at?: number;
	data?: { type?: string; data?: any };
};

/**
 * A socket event applied to a list of messages. `parentId` is null for the
 * channel itself and the thread's root id for a thread panel: a new message
 * is added only to the list it belongs to. A message this client sent is
 * matched by its `temp_id`, replacing the optimistic copy instead of
 * duplicating it. Returns the list unchanged for anything that is not about it.
 */
export function applyMessageEvent(messages: ChannelMessage[], event: ChannelEvent, parentId: string | null = null): ChannelMessage[] {
	const type = event.data?.type ?? '';
	const data = event.data?.data;
	if (!data) return messages;
	if (type === 'message') {
		if ((data.parent_id ?? null) !== parentId) return messages;
		const tempId = data.temp_id ?? null;
		const rest = messages.filter((m) => m.id !== data.id && (!tempId || m.temp_id !== tempId));
		return [{ ...data, temp_id: null }, ...rest];
	}
	if (type === 'message:delete') return messages.filter((m) => m.id !== data.id);
	if (type === 'message:update' || type === 'message:reply' || type.startsWith('message:reaction')) {
		return messages.map((m) => (m.id === data.id ? data : m));
	}
	return messages;
}

/** Who is typing, after a `typing` event: added (once) or removed. The caller expires each after a few seconds. */
export function applyTyping(typing: ChannelUser[], event: ChannelEvent, selfId: string | undefined): ChannelUser[] {
	const who = event.user;
	if (!who || who.id === selfId) return typing;
	const without = typing.filter((u) => u.id !== who.id);
	return event.data?.data?.typing ? [...without, { id: who.id, name: who.name }] : without;
}

/** Toggles the viewer's reaction, optimistically: counts follow the user list, and an emptied reaction disappears. */
export function toggleReaction(message: ChannelMessage, name: string, me: { id: string; name?: string }): { message: ChannelMessage; added: boolean } {
	const reactions = message.reactions ?? [];
	const existing = reactions.find((r) => r.name === name);
	const mine = existing?.users.some((u) => u.id === me.id) ?? false;
	let next: Reaction[];
	if (mine) {
		next = reactions.map((r) => (r.name === name ? { ...r, users: r.users.filter((u) => u.id !== me.id) } : r)).map((r) => ({ ...r, count: r.users.length }));
		next = next.filter((r) => r.count > 0);
	} else if (existing) {
		next = reactions.map((r) => (r.name === name ? { ...r, users: [...r.users, me], count: r.users.length + 1 } : r));
	} else {
		next = [...reactions, { name, users: [me], count: 1 }];
	}
	return { message: { ...message, reactions: next }, added: !mine };
}

/**
 * Whether a message (in oldest-first display order) starts a new block with
 * the author's name and picture: the first message, a different author or
 * model, or a reply.
 */
export function showsAuthor(list: ChannelMessage[], idx: number): boolean {
	if (idx === 0) return true;
	const prev = list[idx - 1];
	const m = list[idx];
	return prev.user_id !== m.user_id || prev.user?.id !== m.user?.id || prev.meta?.model_id !== m.meta?.model_id || Boolean(m.reply_to_message);
}

/** The name to show for a channel: its name, or for a DM without one, the other members. */
export function channelTitle(channel: Pick<Channel, 'name' | 'type' | 'users'> | null | undefined, selfId: string | undefined): string {
	if (!channel) return 'Channel';
	if (channel.name?.trim()) return channel.name;
	const others = (channel.users ?? []).filter((u) => u.id !== selfId).map((u) => u.name);
	return others.join(', ') || 'Direct Message';
}

// --- mentions ------------------------------------------------------------

export type MentionKind = 'user' | 'model' | 'channel';
export type Mention = { kind: MentionKind; id: string; label: string };

const PREFIX: Record<MentionKind, string> = { user: 'U', model: 'M', channel: 'C' };

/** `<@U:id|label>`: the encoding the backend reads (a model mention makes that model reply). */
export const encodeMention = (m: Mention) => `<@${PREFIX[m.kind]}:${m.id}|${m.label.replace(/[>|]/g, '')}>`;

/** How the composer shows a mention while it is typed: `#general` for a channel, `@Ann` otherwise. */
export const mentionText = (m: Pick<Mention, 'kind' | 'label'>) => `${m.kind === 'channel' ? '#' : '@'}${m.label}`;

/**
 * The composer shows a mention as `@label` (`#label`); on send each chosen
 * mention's first such text still present becomes its encoding. A mention
 * whose text was deleted is dropped, so a deleted `@model` no longer triggers
 * a reply.
 */
export function encodeMentions(text: string, mentions: Mention[]): string {
	let out = text;
	for (const m of mentions) {
		const plain = mentionText(m);
		const at = out.indexOf(plain);
		if (at !== -1) out = out.slice(0, at) + encodeMention(m) + out.slice(at + plain.length);
	}
	return out;
}

/**
 * The `@word` (users and models) or `#word` (channels) being typed just
 * before the cursor, if any: what to suggest mentions for.
 */
export function mentionQuery(text: string, cursor: number): { trigger: '@' | '#'; query: string; start: number } | null {
	const before = text.slice(0, cursor);
	const m = /(^|\s)([@#])([\w.-]*)$/.exec(before);
	return m ? { trigger: m[2] as '@' | '#', query: m[3], start: cursor - m[3].length - 1 } : null;
}

/** A timestamp in nanoseconds, now. */
export const nowNs = () => Date.now() * 1_000_000;

// --- the channel list ----------------------------------------------------

const TYPE_ORDER = ['', null, 'group', 'dm'];

/** Standard channels first, then group channels, then direct messages (Sidebar.svelte's initChannels sort; stable within a type). */
export const sortChannels = (list: Channel[]) => [...list].sort((a, b) => TYPE_ORDER.indexOf(a.type ?? null) - TYPE_ORDER.indexOf(b.type ?? null));

const publicReadGrant = (grants: Channel['access_grants']) =>
	Array.isArray(grants) && grants.some((g) => g?.principal_type === 'user' && g?.principal_id === '*' && g?.permission === 'read');

/** Whether the channel shows a `#` (public) or a lock: a group channel's own flag, else a public read grant. */
export function isPublicChannel(channel: Pick<Channel, 'type' | 'is_private' | 'access_grants'> | null | undefined): boolean {
	if (channel?.type === 'group' && typeof channel.is_private === 'boolean') return !channel.is_private;
	return publicReadGrant(channel?.access_grants);
}

/**
 * The channel list after a socket event, for the sidebar's unread counts
 * (+layout.svelte's channelEventHandler). Returns null when the list must be
 * refetched instead: a channel was created, or a message came from a channel
 * the list does not know yet. A new message from someone else in a channel
 * that is not open bumps its count; anything else leaves the list alone.
 */
export function applyUnreadEvent(list: Channel[], event: ChannelEvent, openChannelId: string | null, selfId: string | undefined): Channel[] | null {
	const type = event.data?.type;
	if (type === 'channel:created') return null;
	if (type !== 'message' || event.user?.id === selfId || event.channel_id === openChannelId) return list;
	if (!list.some((c) => c.id === event.channel_id)) return null;
	return list.map((c) => (c.id === event.channel_id ? { ...c, unread_count: (c.unread_count ?? 0) + 1, last_message_at: event.created_at ?? c.last_message_at } : c));
}

/** The list with one channel's unread count cleared. */
export const markRead = (list: Channel[], channelId: string) => list.map((c) => (c.id === channelId && c.unread_count ? { ...c, unread_count: 0 } : c));

/** A compact unread badge: 7, 1.2K. */
export const formatUnread = (count: number) => new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short' }).format(count);

/**
 * The channel form's name rule (ChannelModal.svelte): whitespace becomes `-`
 * and it is lower-cased as it is typed.
 */
export const normalizeChannelName = (name: string) => name.replace(/\s/g, '-').toLocaleLowerCase();

export type ChannelFormValue = { type: '' | 'group' | 'dm'; name: string; isPrivate: boolean; accessGrants: NonNullable<Channel['access_grants']>; userIds: string[] };

/** What a channel form sends, or the error to show instead. */
export function channelPayload(v: ChannelFormValue): { error: string } | { payload: Record<string, unknown> } {
	const name = normalizeChannelName(v.name.trim());
	if (name.length > 128) return { error: 'Channel name must be less than 128 characters' };
	if (v.type === 'dm' && v.userIds.length === 0) return { error: 'Please select at least one user for Direct Message channel.' };
	if (v.type !== 'dm' && !name) return { error: 'Channel name cannot be empty.' };
	return {
		payload: {
			type: v.type,
			name,
			is_private: v.type === 'group' ? v.isPrivate : null,
			access_grants: v.type === '' ? v.accessGrants : [],
			group_ids: [],
			user_ids: v.userIds
		}
	};
}

// --- rendering -------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Message Markdown with each `<@U:id|label>` mention turned into a styled
 * `@label` (`#label` for a channel). The result still goes through the
 * Markdown renderer and DOMPurify; the label is escaped here because it is
 * user text inside HTML.
 */
export function renderMentions(content: string): string {
	return content.replace(/<@([UMC]):([^|>]+)\|([^>]*)>/g, (_all, kind: string, _id: string, label: string) => {
		const text = `${kind === 'C' ? '#' : '@'}${escapeHtml(label)}`;
		return `<span class="mention" data-kind="${kind}">${text}</span>`;
	});
}

/** "You, Ann and Bob reacted with :tada:" (Message.svelte's tooltip: three names, then "and N others" past four). */
export function reactionTooltip(reaction: Reaction, selfId: string | undefined): string {
	const names = reaction.users.map((u) => (u.id === selfId ? 'You' : (u.name ?? 'Someone')));
	const total = names.length;
	let who = '';
	names.slice(0, 3).forEach((name, idx) => {
		who += idx === 0 ? name : `${idx === Math.min(2, total - 1) ? ' and ' : ', '}${name}`;
	});
	if (total > 4) who += ` and ${total - 3} others`;
	return `${who} reacted with :${reaction.name}:`;
}

type FileRef = { url?: string; content_type?: string };

/** A message attachment's URL: data and http URLs as they are, else the file's API route. */
export function attachmentUrl(file: FileRef, apiBase: string): string {
	const url = file.url ?? '';
	if (url.startsWith('data') || url.startsWith('http')) return url;
	return `${apiBase}/files/${url}${file.content_type ? '/content' : ''}`;
}

/** The files on a message, or none while its data is still a `true` placeholder. */
export const messageFiles = (m: ChannelMessage) => (m.data && m.data !== true ? (m.data.files ?? []) : []);
