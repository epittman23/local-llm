import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHONE_QUERY, topBandBottom, useTopBand } from './topBand';

const rect = (top: number, bottom: number) =>
	({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

/** An app bar holding its menu button, with the rects given. */
function makeBar(barBottom: number, menuBottom: number) {
	const bar = document.createElement('header');
	const menu = document.createElement('button');
	bar.append(menu);
	bar.getBoundingClientRect = () => rect(0, barBottom);
	menu.getBoundingClientRect = () => rect(8, menuBottom);
	document.body.append(bar);
	return bar;
}

function pageTop(top: number, bottom: number) {
	const element = document.createElement('div');
	element.setAttribute('data-page-top', '');
	element.getBoundingClientRect = () => rect(top, bottom);
	document.body.append(element);
	return element;
}

/** A matchMedia answering PHONE_QUERY with `phone`, which the test can change live. */
function mockPhone(phone: boolean) {
	const listeners = new Set<() => void>();
	let matches = phone;
	vi.stubGlobal('matchMedia', (query: string) => ({
		get matches() {
			return query === PHONE_QUERY && matches;
		},
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
	}));
	return (next: boolean) => {
		matches = next;
		for (const fn of listeners) fn();
	};
}

const band = () => document.documentElement.style.getPropertyValue('--top-band-bottom');

afterEach(() => {
	document.body.innerHTML = '';
	document.documentElement.style.removeProperty('--top-band-bottom');
	vi.unstubAllGlobals();
});

describe('topBandBottom', () => {
	it('is the bar, or its floating menu button where the bar has folded', () => {
		expect(topBandBottom(makeBar(57, 48))).toBe(57);
		document.body.innerHTML = '';
		expect(topBandBottom(makeBar(0, 44))).toBe(44);
	});

	it('reaches down to the visible part of a page header, and ignores one scrolled away or hidden', () => {
		vi.stubGlobal('innerHeight', 800);
		const bar = makeBar(57, 48);
		pageTop(61, 159.5);
		expect(topBandBottom(bar)).toBe(160);
		document.querySelector('[data-page-top]')?.remove();
		pageTop(-200, -10); // scrolled out of view
		pageTop(0, 0); // not shown
		expect(topBandBottom(bar)).toBe(57);
		pageTop(-100, 30); // partly scrolled away: only what shows
		expect(topBandBottom(bar)).toBe(57);
		pageTop(500, 2000); // taller than the screen: no lower than its bottom edge
		expect(topBandBottom(bar)).toBe(800);
	});
});

describe('useTopBand', () => {
	it('follows the page on a phone and is 0, watching nothing, from md up', async () => {
		const setPhone = mockPhone(true);
		const observe = vi.spyOn(MutationObserver.prototype, 'observe');
		const bar = makeBar(57, 48);
		const { unmount } = renderHook(() => useTopBand(bar));
		expect(band()).toBe('57px');

		// A header that appears later (the page's data loaded) moves the band down.
		pageTop(61, 120);
		await waitFor(() => expect(band()).toBe('120px'));

		setPhone(false);
		expect(band()).toBe('0px');
		observe.mockClear();
		pageTop(61, 300);
		await new Promise((resolve) => requestAnimationFrame(resolve));
		expect(band()).toBe('0px');
		expect(observe).not.toHaveBeenCalled();

		setPhone(true);
		expect(band()).toBe('300px');
		unmount();
		expect(band()).toBe('');
	});

	it('measures again when a page scrolls', async () => {
		mockPhone(true);
		const bar = makeBar(57, 48);
		let headerBottom = 200;
		const header = pageTop(61, 200);
		header.getBoundingClientRect = () => rect(headerBottom - 139, headerBottom);
		renderHook(() => useTopBand(bar));
		expect(band()).toBe('200px');
		headerBottom = -5;
		document.dispatchEvent(new Event('scroll'));
		await waitFor(() => expect(band()).toBe('57px'));
	});
});
