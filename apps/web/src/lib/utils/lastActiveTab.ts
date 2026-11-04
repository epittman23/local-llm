/**
 * Which of the app's open tabs the user looked at last. Ports the original
 * layout's `isLastActiveTab` (d863707:apps/openwebui/src/routes/+layout.svelte):
 * a tab claims it when it becomes visible and tells the others over a
 * BroadcastChannel, which then stand down. Only that tab plays the sound and
 * shows the desktop notification for a channel message, so two open tabs no
 * longer announce it twice (#254). A tab starts out active, so a single tab
 * opened in the background still notifies.
 */

export type ActiveTabChannel = Pick<
	BroadcastChannel,
	'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'
>;

export const ACTIVE_TAB_CHANNEL = 'active-tab-channel';

export function trackLastActiveTab(
	doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
	channel: ActiveTabChannel | null = typeof BroadcastChannel === 'undefined'
		? null
		: new BroadcastChannel(ACTIVE_TAB_CHANNEL)
) {
	let active = true;
	const claim = () => {
		active = true;
		channel?.postMessage('active');
	};
	const onVisibility = () => {
		if (doc.visibilityState === 'visible') claim();
	};
	const onMessage = (event: Event) => {
		if ((event as MessageEvent).data === 'active') active = false;
	};
	channel?.addEventListener('message', onMessage);
	doc.addEventListener('visibilitychange', onVisibility);
	onVisibility();
	return {
		isActive: () => active,
		stop: () => {
			doc.removeEventListener('visibilitychange', onVisibility);
			channel?.removeEventListener('message', onMessage);
			channel?.close();
		}
	};
}

let current: ReturnType<typeof trackLastActiveTab> | null = null;

/** Starts tracking for this tab (once, from AppShell's channel events hook); returns the stop. */
export function startLastActiveTab(): () => void {
	current?.stop();
	const mine = trackLastActiveTab();
	current = mine;
	return () => {
		mine.stop();
		if (current === mine) current = null;
	};
}

/** Whether this tab is the one to announce a message; true when nothing tracks tabs. */
export const isLastActiveTab = () => current?.isActive() ?? true;
