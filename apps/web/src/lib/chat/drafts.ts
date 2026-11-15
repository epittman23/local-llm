// The message box's unsent text, kept per chat for the browser tab's session
// (#997, #1061): a reload, a chat switch or a sign-in after the session ran
// out puts it back. Keyed by the account and the chat id, or `new:<folder id>`
// for a chat not yet started, so a draft never moves to another chat (#217) or
// to another account signing in on the same tab. Attachments are
// server rows and are not kept here. Storage can be missing or refuse (a
// private window, blocked site data): then nothing is kept and nothing fails.

const PREFIX = 'chat-draft:';

/** Whether a session-storage key holds a draft (kept when a session runs out, #1061). */
export const isDraftKey = (key: string) => key.startsWith(PREFIX);

/** The storage key for an account's draft in a chat: `<userId>:` and its id, else `new:<folderId>`. */
export const draftKeyFor = (userId: string, chatId: string | null | undefined, folderId?: string | null) =>
	`${userId}:${chatId || `new:${folderId ?? ''}`}`;

/** Forgets the drafts other accounts kept through a session that ran out: called when `userId` signs in. */
export function forgetOtherUsersDrafts(userId: string): void {
	try {
		for (const key of Object.keys(sessionStorage))
			if (isDraftKey(key) && !key.startsWith(`${PREFIX}${userId}:`)) sessionStorage.removeItem(key);
	} catch {
		// Storage refused: nothing was kept either.
	}
}

/** Keeps `text` as the draft for `key`; empty text removes it. */
export function saveDraft(key: string, text: string): void {
	try {
		if (text) sessionStorage.setItem(PREFIX + key, text);
		else sessionStorage.removeItem(PREFIX + key);
	} catch {
		// Storage refused: the draft is simply not kept.
	}
}

/** The draft kept for `key`, or '' when there is none. */
export function loadDraft(key: string): string {
	try {
		return sessionStorage.getItem(PREFIX + key) ?? '';
	} catch {
		return '';
	}
}

/** Forgets the draft for `key`. */
export function clearDraft(key: string): void {
	saveDraft(key, '');
}
