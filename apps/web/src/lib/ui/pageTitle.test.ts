import { afterEach, describe, expect, it } from 'vitest';
import {
	clearDynamicTitle,
	composeTitle,
	routeHandle,
	setDynamicTitle,
	TITLE_SEPARATOR,
	usePageTitleStore
} from './pageTitle';

afterEach(() => usePageTitleStore.setState({ dynamic: null, owner: null }));

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

	it('is given up when its page sets null', () => {
		const chat = {};
		setDynamicTitle(chat, 'A chat');
		setDynamicTitle(chat, null);
		expect(usePageTitleStore.getState().dynamic).toBeNull();
	});
});
