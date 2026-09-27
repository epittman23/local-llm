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
	data?: { files?: { id?: string; name?: string; url?: string; type?: string; content_type?: string }[] } | true | null;
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
	access_grants?: unknown[];
};
export type ChannelEvent = { channel_id: string; message_id?: string | null; user?: ChannelUser; data?: { type?: string; data?: any } };

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

/**
 * The composer shows a mention as `@label`; on send each chosen mention's
 * first `@label` still present becomes its encoding. A mention whose text was
 * deleted is dropped, so a deleted `@model` no longer triggers a reply.
 */
export function encodeMentions(text: string, mentions: Mention[]): string {
	let out = text;
	for (const m of mentions) {
		const plain = `@${m.label}`;
		const at = out.indexOf(plain);
		if (at !== -1) out = out.slice(0, at) + encodeMention(m) + out.slice(at + plain.length);
	}
	return out;
}

/** The `@word` being typed just before the cursor, if any: what to suggest mentions for. */
export function mentionQuery(text: string, cursor: number): { query: string; start: number } | null {
	const before = text.slice(0, cursor);
	const m = /(^|\s)@([\w.-]*)$/.exec(before);
	return m ? { query: m[2], start: cursor - m[2].length - 1 } : null;
}

/** A timestamp in nanoseconds, now. */
export const nowNs = () => Date.now() * 1_000_000;
