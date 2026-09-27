import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyFallback, svelteOnlySurface, svelteUrl } from './LegacyFallback';

describe('svelteOnlySurface', () => {
	it('claims nothing once the chat is ported (Phase 10)', () => {
		expect(svelteOnlySurface('/c/abc')).toBeNull();
		expect(svelteOnlySurface('/home')).toBeNull();
		expect(svelteOnlySurface('/folders/f1')).toBeNull();
		expect(svelteOnlySurface('/channels/c1')).toBeNull();
	});
	it('does not claim look-alikes or anything else', () => {
		expect(svelteOnlySurface('/homework')).toBeNull();
		expect(svelteOnlySurface('/c')).toBeNull();
		expect(svelteOnlySurface('/nope')).toBeNull();
	});
	it('points at the Svelte dev server in development and the same path in a build', () => {
		expect(svelteUrl('/c/1?x=1', true)).toBe('http://localhost:5173/c/1?x=1');
		expect(svelteUrl('/c/1', false)).toBe('/c/1');
	});
});

describe('LegacyFallback', () => {
	afterEach(() => vi.restoreAllMocks());
	const renderAt = (path: string) => render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <LegacyFallback /> }], { initialEntries: [path] })} />);

	it('never navigates on its own (that looped on the dev server)', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		renderAt('/c/abc');
		renderAt('/typo');
		expect(assign).not.toHaveBeenCalled();
	});
	it('shows a 404 for anything else', () => {
		renderAt('/typo');
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
	});
});
