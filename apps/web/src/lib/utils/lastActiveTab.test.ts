import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActiveTabChannel, isLastActiveTab, startLastActiveTab, trackLastActiveTab } from './lastActiveTab';

// #254: every open tab played the sound and showed the desktop notification
// for each channel message. Only the tab looked at last does now.

/** A BroadcastChannel stand-in: what one tab posts reaches every other tab on the bus. */
function bus() {
	const tabs: { channel: ActiveTabChannel; listeners: Set<(e: Event) => void> }[] = [];
	return () => {
		const listeners = new Set<(e: Event) => void>();
		const self = {
			listeners,
			channel: {
				postMessage: (data: unknown) => {
					for (const tab of tabs)
						if (tab !== self) for (const l of tab.listeners) l(new MessageEvent('message', { data }));
				},
				addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
				removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
				close: vi.fn()
			} as unknown as ActiveTabChannel
		};
		tabs.push(self);
		return self.channel;
	};
}

/** A document whose visibility a test sets. */
function page(state: DocumentVisibilityState) {
	const target = new EventTarget();
	const doc = {
		visibilityState: state,
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target)
	};
	return {
		doc: doc as unknown as Document,
		show: () => {
			doc.visibilityState = 'visible';
			target.dispatchEvent(new Event('visibilitychange'));
		},
		hide: () => {
			doc.visibilityState = 'hidden';
			target.dispatchEvent(new Event('visibilitychange'));
		}
	};
}

describe('trackLastActiveTab (#254)', () => {
	it('the tab shown last is the only active one', () => {
		const channel = bus();
		const a = page('visible');
		const tabA = trackLastActiveTab(a.doc, channel());
		const b = page('visible');
		const tabB = trackLastActiveTab(b.doc, channel());
		expect([tabA.isActive(), tabB.isActive()]).toEqual([false, true]);

		b.hide();
		a.show();
		expect([tabA.isActive(), tabB.isActive()]).toEqual([true, false]);
		// Hiding it does not hand the role back: the last one looked at keeps it.
		a.hide();
		expect([tabA.isActive(), tabB.isActive()]).toEqual([true, false]);
	});

	it('a single tab opened in the background is active', () => {
		const tab = trackLastActiveTab(page('hidden').doc, bus()());
		expect(tab.isActive()).toBe(true);
	});

	it('works without BroadcastChannel, as one tab', () => {
		const p = page('visible');
		const tab = trackLastActiveTab(p.doc, null);
		p.hide();
		p.show();
		expect(tab.isActive()).toBe(true);
	});

	it('stop closes the channel and stops listening', () => {
		const channel = bus();
		const own = channel();
		const a = page('visible');
		const tab = trackLastActiveTab(a.doc, own);
		tab.stop();
		expect(own.close).toHaveBeenCalled();
		trackLastActiveTab(page('visible').doc, channel());
		expect(tab.isActive()).toBe(true);
	});
});

describe('isLastActiveTab', () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	it('is true while nothing tracks tabs, and follows the tracker once started', () => {
		expect(isLastActiveTab()).toBe(true);
		stop = startLastActiveTab();
		expect(isLastActiveTab()).toBe(true);
		stop();
		stop = undefined;
		expect(isLastActiveTab()).toBe(true);
	});

	it('a second start replaces the first', () => {
		const first = startLastActiveTab();
		stop = startLastActiveTab();
		first();
		expect(isLastActiveTab()).toBe(true);
	});
});
