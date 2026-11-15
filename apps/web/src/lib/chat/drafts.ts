// The message box's unsent text, kept per chat for the browser tab's session
// (#997, #1061): a reload, a chat switch or a sign-in after the session ran
// out puts it back. Keyed by chat id, or `new:<folder id>` for a chat not yet
// started, so a draft never moves to another chat (#217). Attachments are
// server rows and are not kept here. Storage can be missing or refuse (a
// private window, blocked site data): then nothing is kept and nothing fails.

const PREFIX = 'chat-draft:';

/** The storage key for a chat's draft: its id, else `new:<folderId>`. */
export const draftKeyFor = (chatId: string | null | undefined, folderId?: string | null) =>
	chatId || `new:${folderId ?? ''}`;

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
