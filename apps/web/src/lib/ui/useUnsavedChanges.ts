import { createElement, type ReactElement, useCallback, useEffect, useRef } from 'react';
import { type BlockerFunction, useBlocker } from 'react-router';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const DEFAULT_MESSAGE = 'Your changes are not saved. They are lost if you leave this page.';

/**
 * FRM-3: a page that saves on request asks before its unsaved changes are lost.
 * While `dirty`, leaving for another page in the app (a link, a tab, Back, the
 * browser's Back) stops at "Discard changes?", and reloading or closing the tab
 * has the browser ask. Not in the desktop app: Electron cancels a prevented
 * unload without asking, so its window would silently refuse to close.
 *
 * Render the returned `dialog`. Call `allowNext()` just before navigating away
 * after a successful save, while the page may still count as dirty, so that one
 * navigation goes through. `dirty` should compare values with a baseline, not
 * count change events, so a seeded or formatted value never counts.
 */
export function useUnsavedChanges(
	dirty: boolean,
	{ message = DEFAULT_MESSAGE }: { message?: string } = {}
): { dialog: ReactElement; allowNext: () => void } {
	// Refs, so the blocker always sees this render's answer: the router reads its
	// function from an effect, which would otherwise lag a save's navigate.
	const dirtyNow = useRef(dirty);
	dirtyNow.current = dirty;
	const allowed = useRef(false);

	const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
		if (allowed.current) {
			allowed.current = false;
			return false;
		}
		const moving = currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search;
		return dirtyNow.current && moving;
	}, []);
	const blocker = useBlocker(shouldBlock);

	useEffect(() => {
		if (!dirty || 'lllmDesktop' in window) return;
		const ask = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', ask);
		return () => window.removeEventListener('beforeunload', ask);
	}, [dirty]);

	const allowNext = useCallback(() => {
		allowed.current = true;
	}, []);

	const dialog = createElement(
		ConfirmDialog,
		{
			open: blocker.state === 'blocked',
			onOpenChange: (open: boolean) => {
				if (!open && blocker.state === 'blocked') blocker.reset();
			},
			title: 'Discard changes?',
			confirmLabel: 'Discard changes',
			cancelLabel: 'Keep editing',
			destructive: true,
			onConfirm: () => {
				if (blocker.state !== 'blocked') return;
				// A history move (the browser's Back) is replayed on proceed and checked again: let it through.
				allowed.current = true;
				blocker.proceed();
			}
		},
		message
	);
	return { dialog, allowNext };
}
