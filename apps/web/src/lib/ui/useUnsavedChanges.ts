import { createElement, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { type Blocker, type BlockerFunction, useBlocker } from 'react-router';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const DEFAULT_MESSAGE = 'Your changes are not saved. They are lost if you leave this page.';

/**
 * FRM-3: a page that saves on request asks before its unsaved changes are lost.
 * While `dirty`, leaving for another page in the app (a link, a tab, Back, the
 * browser's Back, another `?id=`) stops at "Discard changes?"; the Settings
 * dialog opening or closing over the page (only `?settings=` changes) does
 * not, since the page stays. Reloading or closing the tab
 * has the browser ask. Not in the desktop app: Electron cancels a prevented
 * unload without asking, so its window would silently refuse to close.
 *
 * Render the returned `dialog`. Call `allowNext()` just before navigating away
 * after a successful save, while the page may still count as dirty, so that one
 * navigation goes through. `dirty` should compare values with a baseline, not
 * count change events, so a seeded or formatted value never counts.
 *
 * A leave that is not a navigation (a page that swaps an editor out for its
 * list in place) goes through `confirmLeave(action)`: it runs `action` at once
 * while nothing is unsaved, and otherwise asks the same question first. An
 * `action` that navigates is let through, so it never asks twice; one that
 * only closes something (a dialog with a draft) leaves the guard as it was.
 *
 * NAV-4, OVL-2: Keep editing puts focus back where it was when the question
 * was raised. A press on a dialog's scrim moves focus to <body> first, so
 * then it goes back to the control focused last before that, or, if that has
 * gone, to the first control of the dialog still open underneath.
 */
export function useUnsavedChanges(dirty: boolean, options: GuardOptions = {}): LeaveGuard {
	return useLeaveGuard(dirty, options, useBlocker, true);
}

/**
 * `useUnsavedChanges` without its navigation guard: only `confirmLeave` (and
 * its dialog) for a leave in place. For an editor embedded where something
 * else already guards navigation (a settings tab, whose host asks once): a
 * router keeps one blocker, the one registered last, so a second would
 * silently replace the host's.
 */
export function useConfirmLeave(dirty: boolean, options: GuardOptions = {}): LeaveGuard {
	return useLeaveGuard(dirty, options, useNoBlocker, false);
}

type GuardOptions = {
	message?: string;
	/** Where Keep editing puts focus when the editor is known (a code editor whose Close button raised the question), instead of what had focus. */
	keepFocus?: () => HTMLElement | null;
};

type LeaveGuard = { dialog: ReactElement; allowNext: () => void; confirmLeave: (action: () => void) => void };

const UNBLOCKED: Blocker = { state: 'unblocked', proceed: undefined, reset: undefined, location: undefined };
const useNoBlocker = (_shouldBlock: BlockerFunction): Blocker => UNBLOCKED;

function useLeaveGuard(
	dirty: boolean,
	{ message = DEFAULT_MESSAGE, keepFocus }: GuardOptions,
	useGuardBlocker: (shouldBlock: BlockerFunction) => Blocker,
	askOnUnload: boolean
): LeaveGuard {
	// Refs, so the blocker always sees this render's answer: the router reads its
	// function from an effect, which would otherwise lag a save's navigate.
	const dirtyNow = useRef(dirty);
	dirtyNow.current = dirty;
	const allowed = useRef(false);
	const confirmed = useRef(false);
	// Where Keep editing returns focus, and whether the dialog is closing on Discard instead.
	const returnTo = useRef<HTMLElement | null>(null);
	const discarding = useRef(false);
	const lastFocused = useRef<HTMLElement | null>(null);
	const keepFocusRef = useRef(keepFocus);
	keepFocusRef.current = keepFocus;
	const rememberFocus = useCallback(() => {
		const active = document.activeElement;
		returnTo.current =
			keepFocusRef.current?.() ??
			(active instanceof HTMLElement && active !== document.body ? active : lastFocused.current);
	}, []);
	useEffect(() => {
		if (!dirty) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body) lastFocused.current = active;
		const note = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement) lastFocused.current = event.target;
		};
		document.addEventListener('focusin', note);
		return () => document.removeEventListener('focusin', note);
	}, [dirty]);

	const shouldBlock = useCallback<BlockerFunction>(
		({ currentLocation, nextLocation }) => {
			// The Settings dialog opening or closing over the page (`?settings=`) leaves nothing,
			// and must not use up a pending allowNext either.
			const moving =
				currentLocation.pathname !== nextLocation.pathname ||
				withoutSettings(currentLocation.search) !== withoutSettings(nextLocation.search);
			if (!moving) return false;
			if (allowed.current) {
				allowed.current = false;
				return false;
			}
			const block = dirtyNow.current;
			if (block) rememberFocus();
			return block;
		},
		[rememberFocus]
	);
	const blocker = useGuardBlocker(shouldBlock);

	useEffect(() => {
		if (!dirty || !askOnUnload || 'lllmDesktop' in window) return;
		const ask = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', ask);
		return () => window.removeEventListener('beforeunload', ask);
	}, [dirty, askOnUnload]);

	const allowNext = useCallback(() => {
		allowed.current = true;
	}, []);

	// The leave confirmLeave is holding while the dialog asks (in an object: a function in state is an updater).
	const [pending, setPending] = useState<{ action: () => void } | null>(null);
	const confirmLeave = useCallback(
		(action: () => void) => {
			if (dirtyNow.current) {
				rememberFocus();
				setPending({ action });
			} else action();
		},
		[rememberFocus]
	);

	const dialog = createElement(
		ConfirmDialog,
		{
			open: blocker.state === 'blocked' || pending !== null,
			onOpenChange: (open: boolean) => {
				if (!open) setPending(null);
				// The dialog closes after Discard changes too; resetting then would cancel a browser Back
				// still on its way (the router replays it once its history move settles).
				if (!open && blocker.state === 'blocked' && !confirmed.current) blocker.reset();
				confirmed.current = false;
			},
			title: 'Discard changes?',
			confirmLabel: 'Discard changes',
			cancelLabel: 'Keep editing',
			destructive: true,
			onCloseAutoFocus: (event: Event) => {
				const target = discarding.current ? undefined : keptFocusTarget(returnTo.current);
				discarding.current = false;
				returnTo.current = null;
				// After Discard the dialog's own way out decides (a closed dialog returns focus to its opener).
				if (!target) return;
				event.preventDefault();
				target.focus({ preventScroll: true });
			},
			onConfirm: () => {
				discarding.current = true;
				if (pending) {
					setPending(null);
					// A navigating action is blocked or let through as it starts; one that only closes
					// something (a dialog) must not leave the next real leave unasked.
					allowed.current = true;
					pending.action();
					setTimeout(() => {
						allowed.current = false;
					});
					return;
				}
				if (blocker.state !== 'blocked') return;
				confirmed.current = true;
				blocker.proceed();
			}
		},
		message
	);
	return { dialog, allowNext, confirmLeave };
}

/** A query string without `settings`, the Settings dialog's address (lib/settings/useSettingsUrl.ts). */
function withoutSettings(search: string): string {
	const params = new URLSearchParams(search);
	params.delete('settings');
	return params.toString();
}

const TABBABLE =
	'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Where Keep editing puts focus: what had it, or else the first control of the topmost open dialog. */
function keptFocusTarget(remembered: HTMLElement | null): HTMLElement | undefined {
	if (remembered?.isConnected) return remembered;
	const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]');
	const dialog = dialogs[dialogs.length - 1];
	return dialog?.querySelector<HTMLElement>(TABBABLE) ?? dialog;
}
