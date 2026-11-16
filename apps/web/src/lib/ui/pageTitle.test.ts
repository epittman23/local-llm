import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDocumentTitle } from '@/lib/stores/configStore';
import {
	clearDynamicTitle,
	composeTitle,
	routeHandle,
	setDynamicTitle,
	TITLE_SEPARATOR,
	usePageTitleStore
} from './pageTitle';

afterEach(() => usePageTitleStore.setState({ dynamic: null, owner: null, below: [] }));

describe('composeTitle (LAY-5)', () => {
	it('puts the page first and the product after a middle dot', () => {
		expect(TITLE_SEPARATOR).toBe(' · ');
		expect(composeTitle('Serve', 'local-llm')).toBe('Serve · local-llm');
		expect(composeTitle('Sample variance walkthrough', 'local-llm')).toBe('Sample variance walkthrough · local-llm');
	});

	it('is the name alone when there is no page', () => {
		expect(composeTitle(undefined, 'local-llm')).toBe('local-llm');
		expect(composeTitle(null, 'local-llm')).toBe('local-llm');
		expect(composeTitle('   ', 'local-llm')).toBe('local-llm');
	});
});

describe('routeHandle', () => {
	it('takes the deepest title and the deepest heading, each on its own', () => {
		const matches = [
			{ handle: undefined },
			{ handle: { title: 'Workspace', heading: 'layout' } },
			{ handle: { title: 'Models' } }
		];
		expect(routeHandle(matches)).toEqual({ title: 'Models', heading: 'layout' });
	});

	it('takes foldsBar from the section route above the page', () => {
		const matches = [{ handle: { foldsBar: true } }, { handle: { title: 'Serve', heading: 'layout' } }];
		expect(routeHandle(matches)).toEqual({ title: 'Serve', heading: 'layout', foldsBar: true });
	});

	it('is empty for routes without handles, public or not', () => {
		expect(routeHandle([{ handle: undefined }, { handle: null }])).toEqual({});
		expect(routeHandle([])).toEqual({});
	});
});

describe('the dynamic piece', () => {
	it('belongs to the page that set it: another page cannot clear it', () => {
		const chat = {};
		const notes = {};
		setDynamicTitle(chat, 'Sample variance walkthrough');
		clearDynamicTitle(notes);
		expect(usePageTitleStore.getState().dynamic).toBe('Sample variance walkthrough');
		setDynamicTitle(notes, null);
		expect(usePageTitleStore.getState().dynamic).toBe('Sample variance walkthrough');
		clearDynamicTitle(chat);
		expect(usePageTitleStore.getState()).toMatchObject({ dynamic: null, owner: null });
	});

	it('comes back to the page when a dialog over it gives its own up (the Settings dialog, S5-D6)', () => {
		const page = {};
		const dialog = {};
		setDynamicTitle(page, 'General · Settings');
		setDynamicTitle(dialog, 'Settings');
		expect(usePageTitleStore.getState().dynamic).toBe('Settings');
		// The page renaming itself underneath does not take the title from the dialog.
		setDynamicTitle(page, 'Database · Settings');
		expect(usePageTitleStore.getState().dynamic).toBe('Settings');
		setDynamicTitle(dialog, null);
		expect(usePageTitleStore.getState()).toMatchObject({ dynamic: 'Database · Settings', owner: page, below: [] });
		clearDynamicTitle(page);
		expect(usePageTitleStore.getState()).toMatchObject({ dynamic: null, owner: null });
	});

	it("puts a page's title back through useDocumentTitle when the Settings dialog over it closes", () => {
		const page = renderHook(() => useDocumentTitle('General · Settings'));
		const dialog = renderHook(({ open }) => useDocumentTitle(open ? 'Settings' : null), {
			initialProps: { open: true }
		});
		expect(usePageTitleStore.getState().dynamic).toBe('Settings');
		dialog.rerender({ open: false });
		expect(usePageTitleStore.getState().dynamic).toBe('General · Settings');
		dialog.unmount();
		page.unmount();
		expect(usePageTitleStore.getState().dynamic).toBeNull();
	});

	it('forgets a covered page that goes first, so its name never comes back', () => {
		const page = {};
		const dialog = {};
		setDynamicTitle(page, 'Notes');
		setDynamicTitle(dialog, 'Settings');
		clearDynamicTitle(page);
		expect(usePageTitleStore.getState().dynamic).toBe('Settings');
		clearDynamicTitle(dialog);
		expect(usePageTitleStore.getState()).toMatchObject({ dynamic: null, owner: null, below: [] });
	});

	it('is given up when its page sets null', () => {
		const chat = {};
		setDynamicTitle(chat, 'A chat');
		setDynamicTitle(chat, null);
		expect(usePageTitleStore.getState().dynamic).toBeNull();
	});
});
