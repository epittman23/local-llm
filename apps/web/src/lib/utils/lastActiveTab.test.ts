import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ACTIVE_TAB_CHANNEL,
	type ActiveTabChannel,
	isLastActiveTab,
	startLastActiveTab,
	trackLastActiveTab
} from './lastActiveTab';

// #254: every open tab played the sound and showed the desktop notification
// for each channel message. Only the tab looked at last does now.

/** A BroadcastChannel stand-in: what one tab posts reaches every other tab on the bus. */
function bus() {
	const tabs: Set<(e: Event) => void>[] = [];
	return () => {
		const listeners = new Set<(e: Event) => void>();
		tabs.push(listeners);
		return {
			postMessage: (data: unknown) => {
				for (const tab of tabs)
					if (tab !== listeners) for (const l of [...tab]) l(new MessageEvent('message', { data }));
			},
			addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
			removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
			close: vi.fn()
		} as unknown as ActiveTabChannel;
	};
}

let clock = 1000;
/** A tab: its document's visibility and its window's focus and pagehide, which a test drives. */
function tab(channel: () => ActiveTabChannel, state: DocumentVisibilityState, id: string) {
	const doc = Object.assign(new EventTarget(), { visibilityState: state });
	const win = new EventTarget();
	const tracker = trackLastActiveTab({ doc, win, channel: channel(), now: () => clock, id });
	return {
		...tracker,
		show: () => {
			clock += 1;
			doc.visibilityState = 'visible';
			doc.dispatchEvent(new Event('visibilitychange'));
		},
		hide: () => {
			doc.visibilityState = 'hidden';
			doc.dispatchEvent(new Event('visibilitychange'));
		},
		focus: () => {
			clock += 1;
			win.dispatchEvent(new Event('focus'));
		},
		close: () => {
			win.dispatchEvent(new Event('pagehide'));
			tracker.stop();
		}
	};
}

describe('trackLastActiveTab (#254)', () => {
	it('the tab shown last is the only active one, and keeps the role when hidden', () => {
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		clock += 1;
		const b = tab(channel, 'visible', 'b');
		expect([a.isActive(), b.isActive()]).toEqual([false, true]);

		b.hide();
		a.show();
		expect([a.isActive(), b.isActive()]).toEqual([true, false]);
		a.hide();
		expect([a.isActive(), b.isActive()]).toEqual([true, false]);
	});

	it('a tab opened in the background stands down for the active one', () => {
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		const b = tab(channel, 'hidden', 'b');
		expect([a.isActive(), b.isActive()]).toEqual([true, false]);
	});

	it('a tab alone is active, even opened in the background', () => {
		expect(tab(bus(), 'hidden', 'a').isActive()).toBe(true);
	});

	it('when the active tab closes, another takes over', () => {
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		clock += 1;
		const b = tab(channel, 'visible', 'b');
		expect(a.isActive()).toBe(false);
		b.close();
		expect(a.isActive()).toBe(true);
	});

	it('when the active tab stops tracking without closing, another takes over (#621)', () => {
		// The app left (a client-side link to a page outside AppShell) but the tab stays open.
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		clock += 1;
		const b = tab(channel, 'visible', 'b');
		expect(a.isActive()).toBe(false);
		b.stop();
		expect(a.isActive()).toBe(true);
	});

	it('a tab that stood down stops without prompting a claim', () => {
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		clock += 1;
		const b = tab(channel, 'visible', 'b');
		a.stop();
		expect(b.isActive()).toBe(true);
	});

	it('of two tabs claiming at the same moment, exactly one is active', () => {
		const channel = bus();
		const a = tab(channel, 'hidden', 'a');
		const b = tab(channel, 'hidden', 'b');
		a.show();
		clock -= 1;
		b.show();
		expect([a.isActive(), b.isActive()].filter(Boolean)).toHaveLength(1);
	});

	it('focusing a window claims the role, as showing it does', () => {
		const channel = bus();
		const a = tab(channel, 'visible', 'a');
		clock += 1;
		const b = tab(channel, 'visible', 'b');
		a.focus();
		expect([a.isActive(), b.isActive()]).toEqual([true, false]);
	});

	it('works without BroadcastChannel, as one tab', () => {
		const tracker = trackLastActiveTab({
			doc: Object.assign(new EventTarget(), { visibilityState: 'visible' as const }),
			win: new EventTarget(),
			channel: null
		});
		expect(tracker.isActive()).toBe(true);
	});

	it('stop closes the channel and stops listening', () => {
		const channel = bus();
		const own = channel();
		const tracker = trackLastActiveTab({
			doc: Object.assign(new EventTarget(), { visibilityState: 'visible' as const }),
			win: new EventTarget(),
			channel: own,
			now: () => clock
		});
		tracker.stop();
		expect(own.close).toHaveBeenCalled();
		clock += 1;
		tab(channel, 'visible', 'z');
		expect(tracker.isActive()).toBe(true);
	});
});

describe('isLastActiveTab', () => {
	let stop: (() => void) | undefined;
	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it('is true while nothing tracks tabs', () => {
		expect(isLastActiveTab()).toBe(true);
	});

	it('follows this tab’s tracker: false once another tab claims later', async () => {
		stop = startLastActiveTab();
		expect(isLastActiveTab()).toBe(true);
		const other = new BroadcastChannel(ACTIVE_TAB_CHANNEL);
		other.postMessage({ type: 'claim', at: Date.now() + 60_000, id: 'other' });
		await vi.waitFor(() => expect(isLastActiveTab()).toBe(false));
		other.close();
	});

	it('a second start replaces the first', () => {
		const first = startLastActiveTab();
		stop = startLastActiveTab();
		first();
		expect(isLastActiveTab()).toBe(true);
	});
});
