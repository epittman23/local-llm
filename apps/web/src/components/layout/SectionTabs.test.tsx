import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionSkeleton, type SectionTab, SectionTabs } from './SectionTabs';

const TABS: SectionTab[] = [
	{ to: '/benchmarks/serve', label: 'Serve' },
	{ to: '/benchmarks/live', label: 'Live' },
	{ to: '/benchmarks/prescreen', label: 'Pre-screen' }
];

function renderAt(path: string, tabs: SectionTab[] = TABS) {
	const router = createMemoryRouter([{ path: '*', element: <SectionTabs label="Benchmarks" tabs={tabs} /> }], {
		initialEntries: [path]
	});
	render(<RouterProvider router={router} />);
	return router;
}

/** Gives the strip a fixed geometry, since jsdom lays nothing out. */
function setGeometry(el: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: Record<string, number>) {
	Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
	Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
	el.scrollLeft = scrollLeft;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('SectionTabs', () => {
	it('is a named navigation landmark whose open tab is the current page (NAV-1)', () => {
		renderAt('/benchmarks/live');
		const nav = screen.getByRole('navigation', { name: 'Benchmarks' });
		expect(nav).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Live' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Serve' }).getAttribute('aria-current')).toBeNull();
		expect(screen.getByRole('link', { name: 'Serve' }).getAttribute('href')).toBe('/benchmarks/serve');
	});

	it('is at least 24 px tall with a pointer and 44 px on touch (LAY-3)', () => {
		renderAt('/benchmarks/live');
		const link = screen.getByRole('link', { name: 'Live' });
		expect(link.className).toContain('min-h-6');
		expect(link.className).toContain('pointer-coarse:min-h-11');
	});

	it('lets a tab say it is open when its link is not the path it stands for', () => {
		renderAt('/admin/users/overview', [
			{ to: '/admin', label: 'Users', active: true },
			{ to: '/admin/settings', label: 'Settings', active: false }
		]);
		expect(screen.getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
	});

	it('matches an index tab exactly when asked to', () => {
		renderAt('/playground/images', [
			{ to: '/playground', label: 'Chat', end: true },
			{ to: '/playground/images', label: 'Images' }
		]);
		expect(screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBeNull();
		expect(screen.getByRole('link', { name: 'Images' }).getAttribute('aria-current')).toBe('page');
	});

	it('brings the open tab into view on arrival and when another tab opens (LAY-4)', async () => {
		const scrolled: string[] = [];
		vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement, options) {
			expect(options).toMatchObject({ inline: 'nearest' });
			scrolled.push(this.textContent ?? '');
		});
		const router = renderAt('/benchmarks/serve');
		expect(scrolled).toEqual(['Serve']);
		await act(() => router.navigate('/benchmarks/prescreen'));
		expect(scrolled).toEqual(['Serve', 'Pre-screen']);
	});

	it('fades out only the edges that have tabs hidden past them (LAY-4)', () => {
		renderAt('/benchmarks/serve');
		const nav = screen.getByRole('navigation', { name: 'Benchmarks' });
		expect(nav.style.maskImage).toBe('');

		setGeometry(nav, { scrollWidth: 558, clientWidth: 358, scrollLeft: 0 });
		fireEvent.scroll(nav);
		expect(nav.dataset.fadeEnd).toBe('true');
		expect(nav.dataset.fadeStart).toBeUndefined();
		expect(nav.style.maskImage).toContain('transparent)');

		setGeometry(nav, { scrollWidth: 558, clientWidth: 358, scrollLeft: 100 });
		fireEvent.scroll(nav);
		expect(nav.dataset.fadeStart).toBe('true');
		expect(nav.dataset.fadeEnd).toBe('true');

		setGeometry(nav, { scrollWidth: 558, clientWidth: 358, scrollLeft: 200 });
		fireEvent.scroll(nav);
		expect(nav.dataset.fadeStart).toBe('true');
		expect(nav.dataset.fadeEnd).toBeUndefined();
		expect(nav.style.maskImage).toMatch(/^linear-gradient\(to right, transparent/);
	});

	it('measures again, and keeps the open tab in view, when the strip or a tab is resized', () => {
		let resized: () => void = () => {};
		const disconnect = vi.fn();
		const observe = vi.fn();
		const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: () => void) {
					resized = cb;
				}
				observe = observe;
				disconnect = disconnect;
			}
		);
		renderAt('/benchmarks/serve');
		const nav = screen.getByRole('navigation', { name: 'Benchmarks' });
		// The strip and each of its three tabs (a count arriving widens a tab).
		expect(observe).toHaveBeenCalledTimes(4);
		setGeometry(nav, { scrollWidth: 558, clientWidth: 358, scrollLeft: 0 });
		scrolled.mockClear();
		act(() => resized());
		expect(nav.dataset.fadeEnd).toBe('true');
		expect(scrolled).toHaveBeenCalledTimes(1);
		cleanup();
		expect(disconnect).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe('SectionSkeleton', () => {
	it('stands in for the header while loading, and says so to a screen reader (STA-2)', () => {
		render(<SectionSkeleton label="benchmarks" />);
		expect(screen.getByRole('status').textContent).toBe('Loading benchmarks');
		expect(screen.queryByText('Loading…')).toBeNull();
	});
});
