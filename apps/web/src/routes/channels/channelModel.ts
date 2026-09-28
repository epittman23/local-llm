// The rules behind a channel (components/channel/*.svelte): applying the
// live `events:channel` socket events to a message list, optimistic
// reactions, who is typing, the mention encoding, and when a message shows
// its author. Messages are kept newest-first, as the API returns them.

export type Reaction = { name: string; users: { id: string; name?: string }[]; count: number };
export type ChannelUser = { id: string; name: string; role?: string; is_active?: boolean };
/** A message's attachments and model output. */
export type MessageData = { files?: { id?: string | null; name?: string; url?: string; type?: string; content_type?: string }[]; [key: string]: unknown };
export type ChannelMessage = {
	id: string;
	temp_id?: string | null;
	channel_id?: string;
	parent_id?: string | null;
	user_id?: string;
	user?: ChannelUser | null;
	content: string;
	/**
	 * The list endpoints, quotes and the pin event send only whether there is
	 * any (`true`/`false`); `GET …/messages/{id}/data` has the object.
	 */
	data?: MessageData | boolean | null;
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
 * The list a handler keeps: a channel's own messages (`parentId` null) or a
 * thread's replies (`parentId` the root's id). The socket delivers events
 * for every channel the user belongs to, so each rule checks the channel.
 */
export type ChannelScope = { channelId: string; parentId: string | null };

/**
 * A socket event applied to the list `scope` names. A new message is added
 * only to the list it belongs to; one this client sent is matched by its
 * `temp_id`, replacing the optimistic copy instead of duplicating it. An
 * update is merged into the message it names, and an edit or delete also
 * reaches the quotes of that message. Returns the same array when nothing in
 * it changed, so a caller can skip the re-render.
 */
export function applyMessageEvent(messages: ChannelMessage[], event: ChannelEvent, scope: ChannelScope): ChannelMessage[] {
	if (event.channel_id !== scope.channelId) return messages;
	const type = event.data?.type ?? '';
	const data = event.data?.data;
	if (!data?.id) return messages;
	if (type === 'message') {
		if ((data.parent_id ?? null) !== scope.parentId) return messages;
		const tempId = data.temp_id ?? null;
		const rest = messages.filter((m) => m.id !== data.id && (!tempId || m.temp_id !== tempId));
		return [{ ...data, temp_id: null }, ...rest];
	}
	if (type === 'message:delete') {
		return mapChanged(messages, (m) => (m.id === data.id ? null : m.reply_to_message?.id === data.id ? { ...m, reply_to_message: null } : m));
	}
	if (type === 'message:update' || type === 'message:reply' || type.startsWith('message:reaction')) {
		return mapChanged(messages, (m) => {
			if (m.id === data.id) return mergeMessage(m, data);
			const quote = m.reply_to_message;
			if (type === 'message:update' && quote && quote.id === data.id && quote.content !== data.content) return { ...m, reply_to_message: { ...quote, content: data.content, updated_at: data.updated_at } };
			return m;
		});
	}
	return messages;
}

/** Whether the event deletes the thread's root: the thread panel should close, as the backend now rejects replies to it. */
export function closesThread(event: ChannelEvent, scope: ChannelScope): boolean {
	return scope.parentId !== null && event.channel_id === scope.channelId && event.data?.type === 'message:delete' && event.data.data?.id === scope.parentId;
}

/**
 * An update merged into the message it names. A `data` of `true` only says
 * there is some, so it keeps the object already loaded.
 */
function mergeMessage(message: ChannelMessage, update: ChannelMessage): ChannelMessage {
	const merged = { ...message, ...update };
	if (update.data === true && typeof message.data === 'object' && message.data !== null) merged.data = message.data;
	return merged;
}

/** Each message replaced by `fn(m)` (null drops it), or `list` itself when none changed. */
function mapChanged(list: ChannelMessage[], fn: (m: ChannelMessage) => ChannelMessage | null): ChannelMessage[] {
	let changed = false;
	const out: ChannelMessage[] = [];
	for (const m of list) {
		const next = fn(m);
		if (next !== m) changed = true;
		if (next) out.push(next);
	}
	return changed ? out : list;
}

/**
 * Who is typing in the list `scope` names, after an event. A `typing` event
 * adds the user (once, where they already are) or removes them; the user's
 * own message landing removes them too, as clients never send
 * `typing: false`. Anything else returns the same array. The caller also
 * expires each user a few seconds after their last `typing` event.
 */
export function applyTyping(typing: ChannelUser[], event: ChannelEvent, scope: ChannelScope, selfId: string | undefined): ChannelUser[] {
	const who = event.user;
	if (!who || who.id === selfId || event.channel_id !== scope.channelId) return typing;
	const type = event.data?.type;
	const data = event.data?.data;
	const typingHere = type === 'typing' && (event.message_id ?? null) === scope.parentId;
	// A model's reply is sent as the user who mentioned the model, who may still be typing.
	const postedHere = type === 'message' && (data?.parent_id ?? null) === scope.parentId && !data?.meta?.model_id;
	const listed = typing.some((u) => u.id === who.id);
	if (typingHere && data?.typing) return listed ? typing : [...typing, { id: who.id, name: who.name }];
	if ((typingHere || postedHere) && listed) return typing.filter((u) => u.id !== who.id);
	return typing;
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
 * Whether a message starts a new block with the author's name and picture:
 * the oldest message, a different author or model from the message shown
 * above it, or a reply. Takes the list newest-first, as it is kept, so the
 * message above `list[idx]` is `list[idx + 1]`.
 */
export function showsAuthor(list: ChannelMessage[], idx: number): boolean {
	const above = list[idx + 1];
	const m = list[idx];
	if (!above) return true;
	return above.user_id !== m.user_id || above.user?.id !== m.user?.id || above.meta?.model_id !== m.meta?.model_id || Boolean(m.reply_to_message);
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

export type MentionTrigger = '@' | '#';

const PREFIX: Record<MentionKind, string> = { user: 'U', model: 'M', channel: 'C' };

/** The character that starts a mention, in the composer and in its encoding: `#` for a channel, `@` for a user or model. */
export const mentionTrigger = (kind: MentionKind): MentionTrigger => (kind === 'channel' ? '#' : '@');

/**
 * `<@U:id|label>`, `<@M:id|label>` or `<#C:id|label>`: the encoding the
 * backend reads (a model mention makes that model reply), and the one
 * messages sent from the Svelte app carry. The label loses `>` and `|`, which
 * would end the tag early; a label left empty is dropped, and the id stands
 * in for it.
 */
export function encodeMention(m: Mention): string {
	const label = m.label.replace(/[>|]/g, '').trim();
	return `<${mentionTrigger(m.kind)}${PREFIX[m.kind]}:${m.id}${label ? `|${label}` : ''}>`;
}

/** How the composer shows a mention while it is typed: `#general` for a channel, `@Ann` otherwise. */
export const mentionText = (m: Pick<Mention, 'kind' | 'label'>) => `${mentionTrigger(m.kind)}${m.label}`;

const NAME_CHAR = /[\p{L}\p{N}\p{M}_]/u;
// Scripts written without spaces between words: a name run straight into one
// of these (`@GPT-4o帮我翻译`) is still a whole mention.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** A code point that would carry a name on: a letter, digit, mark or `_`, outside those scripts. */
const namePart = (c: string | undefined) => Boolean(c && NAME_CHAR.test(c) && !NO_SPACE_SCRIPT.test(c));

/**
 * Whether `text[at, end)` stands as a whole mention rather than inside a
 * longer word: `@Sam` inside `@Samantha` or `x@Sam` is not a mention of Sam,
 * nor `@GPT` inside `@GPT-4o`. Neighbours are read as code points, so a
 * character outside the Basic Multilingual Plane counts whole.
 */
function standsAlone(text: string, at: number, end: number): boolean {
	const before = Array.from(text.slice(Math.max(0, at - 2), at)).at(-1);
	const [next, then] = Array.from(text.slice(end, end + 4));
	const continues = namePart(next) || ((next === '-' || next === '.') && namePart(then));
	return !namePart(before) && !continues;
}

/**
 * The `[start, end)` ranges of fenced code blocks and inline code spans in
 * Markdown, where an `@name` is just text. Close to CommonMark: a fence of
 * three or more backticks or tildes runs to a closing fence of the same kind
 * and at least its length (or to the end); a run of n backticks opens a span
 * that the next run of exactly n closes, within the paragraph.
 */
export function codeRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let open: { char: string; len: number; start: number } | null = null;
	let offset = 0;
	for (const line of text.split('\n')) {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (open) {
			if (fence && fence[1][0] === open.char && fence[1].length >= open.len && !fence[2].trim()) {
				ranges.push([open.start, offset + line.length]);
				open = null;
			}
		} else if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
			open = { char: fence[1][0], len: fence[1].length, start: offset };
		}
		offset += line.length + 1;
	}
	if (open) ranges.push([open.start, text.length]);

	const fenced = [...ranges];
	const inFence = (p: number) => fenced.some(([s, e]) => p >= s && p < e);
	const runAt = (p: number) => {
		let n = 0;
		while (text[p + n] === '`') n++;
		return n;
	};
	for (let p = 0; p < text.length; ) {
		if (text[p] !== '`' || inFence(p) || text[p - 1] === '\\') {
			p++;
			continue;
		}
		const n = runAt(p);
		let close = -1;
		for (let q = p + n; q < text.length; ) {
			if (text[q] === '\n' && text[q + 1] === '\n') break;
			if (text[q] !== '`') {
				q++;
				continue;
			}
			const k = runAt(q);
			if (k === n) {
				close = q;
				break;
			}
			q += k;
		}
		if (close === -1) {
			p += n;
			continue;
		}
		ranges.push([p, close + n]);
		p = close + n;
	}
	return ranges;
}

/**
 * The composer shows a mention as `@label` (`#label`) and passes one entry
 * per mention inserted. On send, each label's text, wherever it stands as a
 * whole word outside code, becomes an encoding:
 *
 * - Longer labels claim their text first, so `@GPT-4o` is never taken for
 *   `@GPT`.
 * - When different people or models share a label, its occurrences go to
 *   them in the order they were inserted (any extra ones to the last). The
 *   text alone cannot tell them apart, so deleting the first of two leaves
 *   the remaining one with the first's id.
 * - A mention whose text was deleted is dropped, so a deleted `@model` no
 *   longer triggers a reply.
 */
export function encodeMentions(text: string, mentions: Mention[]): string {
	const code = codeRanges(text);
	const taken: { start: number; end: number; tag: string }[] = [];
	const free = (at: number, end: number) => taken.every((t) => end <= t.start || at >= t.end) && code.every(([s, e]) => end <= s || at >= e);
	const byText = new Map<string, Mention[]>();
	for (const m of mentions) if (m.label) byText.set(mentionText(m), [...(byText.get(mentionText(m)) ?? []), m]);
	for (const [plain, group] of [...byText].sort(([a], [b]) => b.length - a.length)) {
		const oneTarget = new Set(group.map((m) => `${m.kind}:${m.id}`)).size === 1;
		let n = 0;
		for (let at = text.indexOf(plain); at !== -1; at = text.indexOf(plain, at + 1)) {
			const end = at + plain.length;
			if (!standsAlone(text, at, end) || !free(at, end)) continue;
			taken.push({ start: at, end, tag: encodeMention(oneTarget ? group[0] : group[Math.min(n, group.length - 1)]) });
			n++;
		}
	}
	// Replaced from the end, so the earlier offsets still hold.
	return taken.sort((a, b) => b.start - a.start).reduce((out, t) => out.slice(0, t.start) + t.tag + out.slice(t.end), text);
}

/**
 * The mention being typed just before the cursor, if any: its trigger (`@`
 * for users and models, `#` for channels), the text after it to suggest
 * for, and where the trigger is. The trigger starts the text or follows
 * whitespace, and the query runs to the cursor without whitespace, so a name
 * in any script, or with an apostrophe, still gets suggestions.
 */
export function mentionQuery(text: string, cursor: number): { trigger: MentionTrigger; query: string; start: number } | null {
	const m = /(?:^|\s)([@#])([^\s@#]*)$/.exec(text.slice(0, cursor));
	return m ? { trigger: m[1] as MentionTrigger, query: m[2], start: cursor - m[2].length - 1 } : null;
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

const MENTION_TAG = /<[@#]([UMC]):([^|>]+)(?:\|([^>]*))?>/g;

/**
 * Message text with each mention tag as plain `@label` (`#label` for a
 * channel; the id when there is no label): for one-line previews and
 * notifications. `<#C:…>` is how channel mentions are stored; `<@C:…>`, which
 * an early port wrote, reads too. Messages themselves render through the chat
 * Markdown renderer, whose mention token draws the chip.
 */
export const mentionsToText = (content: string) => content.replace(MENTION_TAG, (_all, kind: string, id: string, label: string | undefined) => `${kind === 'C' ? '#' : '@'}${label || id}`);

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
