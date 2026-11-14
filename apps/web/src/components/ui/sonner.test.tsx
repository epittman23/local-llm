import { act, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEndReason } from '@/lib/auth/session';
import { useConnectionStore } from '@/lib/socket/connectionStore';
import { keepClearOffset, messageId, Toaster, WIDE_QUERY } from './sonner';

vi.mock('@/lib/auth/session', () => ({ sessionEndReason: vi.fn(() => null) }));

/** A matchMedia whose WIDE_QUERY answer the test sets, and can change live. */
function mockWidth(wide: boolean) {
	const listeners = new Set<() => void>();
	let matches = wide;
	vi.stubGlobal('matchMedia', (query: string) => ({
		get matches() {
			return query === WIDE_QUERY ? matches : false;
		},
		media: query,
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
	}));
	return (next: boolean) => {
		matches = next;
		for (const fn of listeners) fn();
	};
}

const toaster = () => document.querySelector('[data-sonner-toaster]');

/** A message box at `top` px from the top of an 800 px tall viewport. */
function composer(top: number, height = 100) {
	const field = document.createElement('div');
	field.setAttribute('data-composite-field', '');
	field.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
	document.body.append(field);
	return field;
}

describe('Toaster', () => {
	beforeEach(() => {
		vi.stubGlobal('innerHeight', 800);
	});
	afterEach(() => {
		act(() => toast.dismiss());
		vi.unstubAllGlobals();
		useConnectionStore.setState({ lost: false });
		for (const field of document.querySelectorAll('[data-composite-field]')) field.remove();
	});

	it('sits bottom right on a wide screen and moves to the top when the window narrows', async () => {
		const setWide = mockWidth(true);
		render(<Toaster />);
		act(() => void toast.success('Saved'));
		await waitFor(() => expect(toaster()?.getAttribute('data-y-position')).toBe('bottom'));
		expect(toaster()?.getAttribute('data-x-position')).toBe('right');

		act(() => setWide(false));
		await waitFor(() => expect(toaster()?.getAttribute('data-y-position')).toBe('top'));
		expect(toaster()?.getAttribute('data-x-position')).toBe('center');
	});

	it('keeps a failure until it is dismissed, with a close button, and shows a repeat once', async () => {
		mockWidth(true);
		render(<Toaster />);
		act(() => {
			toast.error('Prompt could not be saved');
			toast.error('Prompt could not be saved');
		});
		const shown = await screen.findAllByText('Prompt could not be saved');
		expect(shown).toHaveLength(1);
		const item = shown[0].closest('[data-sonner-toast]') as HTMLElement;
		expect(item.querySelector('[data-close-button]')).not.toBeNull();

		act(() => screen.getByRole('button', { name: 'Close toast' }).click());
		await waitFor(() => expect(screen.queryByText('Prompt could not be saved')).toBeNull());

		// Raised again after a dismissal, the same failure shows again.
		act(() => void toast.error('Prompt could not be saved'));
		expect(await screen.findByText('Prompt could not be saved')).toBeInTheDocument();
	});

	it('gives failures and warnings no time limit and an id from their text; the caller still wins', () => {
		act(() => void toast.warning('Disk almost full'));
		act(() => void toast.error('Quick one', { duration: 1000, id: 'mine' }));
		const toasts = toast.getToasts() as Array<{ id: string | number; duration?: number; title?: unknown }>;
		const warning = toasts.find((t) => t.title === 'Disk almost full');
		expect(warning?.id).toBe(messageId('Disk almost full'));
		expect(warning?.duration).toBe(Number.POSITIVE_INFINITY);
		const mine = toasts.find((t) => t.title === 'Quick one');
		expect(mine?.id).toBe('mine');
		expect(mine?.duration).toBe(1000);
	});

	it('holds back failures once the session has run out: the sign-in page explains them (#1061)', async () => {
		mockWidth(true);
		render(<Toaster />);
		vi.mocked(sessionEndReason).mockReturnValue('expired');
		act(() => void toast.error('Not authenticated'));
		vi.mocked(sessionEndReason).mockReturnValue(null);
		act(() => void toast.success('Saved'));
		expect(await screen.findByText('Saved')).toBeInTheDocument();
		expect(screen.queryByText('Not authenticated')).toBeNull();
	});

	it('lifts toasts above a message box in the lower half of the screen', async () => {
		mockWidth(true);
		composer(640);
		render(<Toaster />);
		act(() => void toast.success('Saved'));
		// 800 - 640 + 8
		await waitFor(() => expect(toaster()?.getAttribute('style')).toContain('--offset-bottom: 168px'));
	});

	it('leaves the offset alone on a phone, and moves toasts below the connection banner', async () => {
		mockWidth(false);
		composer(640);
		useConnectionStore.setState({ lost: true });
		render(<Toaster />);
		act(() => void toast.success('Saved'));
		await waitFor(() => expect(toaster()?.getAttribute('style')).toContain('--mobile-offset-top: 56px'));
		expect(toaster()?.getAttribute('style')).toContain('--offset-bottom: 24px');
	});
});

describe('keepClearOffset', () => {
	beforeEach(() => vi.stubGlobal('innerHeight', 800));
	afterEach(() => {
		vi.unstubAllGlobals();
		for (const field of document.querySelectorAll('[data-composite-field]')) field.remove();
	});

	it('is null with no field, or only one near the top (a search box)', () => {
		expect(keepClearOffset()).toBeNull();
		composer(80, 32);
		expect(keepClearOffset()).toBeNull();
	});

	it('clears the highest field in the lower half, and ignores one with no size', () => {
		composer(700);
		composer(500);
		composer(450, 0);
		expect(keepClearOffset()).toBe(308);
	});

	it('never comes closer to the edge than Sonner itself', () => {
		composer(790, 10);
		expect(keepClearOffset()).toBe(24);
	});
});

describe('messageId', () => {
	it('is stable for the same text and differs for other text', () => {
		expect(messageId('a')).toBe(messageId('a'));
		expect(messageId('a')).not.toBe(messageId('b'));
	});
});
