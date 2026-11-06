/**
 * Which of the app's open tabs the user looked at last. Ports the original
 * layout's `isLastActiveTab` (d863707:apps/openwebui/src/routes/+layout.svelte):
 * a tab claims the role when it is shown or focused and tells the others over a
 * BroadcastChannel, which then stand down. Only that tab plays the sound and
 * shows the desktop notification for a channel message, so open tabs no longer
 * announce it once each (#254).
 *
 * Where the original could end with two active tabs or none, this does not:
 * - a claim carries its time (and a random id for a tie), so of two tabs shown
 *   at once the later claim wins, rather than each standing the other down;
 * - a tab that starts hidden asks, and stands down if an active tab answers; a
 *   tab alone stays active, so it still notifies;
 * - the active tab says when it closes, and the others claim again, the latest
 *   winning, so one is left to announce.
 */

export type ActiveTabChannel = Pick<
	BroadcastChannel,
	'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'
>;

type Message = { type: 'claim'; at: number; id: string } | { type: 'query' } | { type: 'release' };

export const ACTIVE_TAB_CHANNEL = 'active-tab-channel';

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function trackLastActiveTab({
	doc = document,
	win = window,
	channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(ACTIVE_TAB_CHANNEL),
	now = Date.now,
	id = Math.random().toString(36).slice(2)
}: {
	doc?: Target & Pick<Document, 'visibilityState'>;
	win?: Target;
	channel?: ActiveTabChannel | null;
	now?: () => number;
	id?: string;
} = {}) {
	let active = true;
	let stopped = false;
	// This tab's latest claim; a claim is later by its time, then by its id.
	let mine: { at: number; id: string } | null = null;
	const later = (a: { at: number; id: string }, b: { at: number; id: string } | null) =>
		!b || a.at > b.at || (a.at === b.at && a.id > b.id);
	const post = (message: Message) => channel?.postMessage(message);
	const claim = () => {
		// Strictly after this tab's own last claim, whatever the clock says.
		mine = { at: Math.max(now(), (mine?.at ?? 0) + 1), id };
		active = true;
		post({ type: 'claim', ...mine });
	};
	const onMessage = (event: Event) => {
		const message = (event as MessageEvent).data as Message;
		if (message?.type === 'claim') {
			if (later(message, mine)) active = false;
			// An older claim arriving after this tab's: tell its sender again.
			else if (active && mine) post({ type: 'claim', ...mine });
		} else if (message?.type === 'query') {
			if (active && mine) post({ type: 'claim', ...mine });
		} else if (message?.type === 'release') {
			claim();
		}
	};
	const onVisibility = () => {
		if (doc.visibilityState === 'visible') claim();
	};
	const onHide = () => {
		if (!active) return;
		// Going away: stand down first, so this tab does not answer the claims it prompts.
		active = false;
		mine = null;
		post({ type: 'release' });
	};
	channel?.addEventListener('message', onMessage);
	doc.addEventListener('visibilitychange', onVisibility);
	win.addEventListener('focus', claim);
	win.addEventListener('pagehide', onHide);
	if (doc.visibilityState === 'visible') claim();
	else post({ type: 'query' });
	return {
		isActive: () => active,
		stop: () => {
			// Once: a replaced tracker is stopped again by its own cleanup.
			if (stopped) return;
			stopped = true;
			doc.removeEventListener('visibilitychange', onVisibility);
			win.removeEventListener('focus', claim);
			win.removeEventListener('pagehide', onHide);
			channel?.removeEventListener('message', onMessage);
			// Hand the role on, as closing does: the tab may stay open without the app,
			// after a link to a page outside it (#621). No longer listening, it answers
			// none of the claims this prompts.
			if (active && mine) post({ type: 'release' });
			channel?.close();
		}
	};
}

let current: ReturnType<typeof trackLastActiveTab> | null = null;

/** Starts tracking for this tab (once, from AppShell's channel events hook); returns the stop. */
export function startLastActiveTab(): () => void {
	current?.stop();
	const tracker = trackLastActiveTab();
	current = tracker;
	return () => {
		tracker.stop();
		if (current === tracker) current = null;
	};
}

/** Whether this tab is the one to announce a message; true when nothing tracks tabs. */
export const isLastActiveTab = () => current?.isActive() ?? true;
