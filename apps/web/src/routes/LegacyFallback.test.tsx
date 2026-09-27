import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyFallback, svelteOnlySurface, svelteUrl } from './LegacyFallback';

describe('svelteOnlySurface', () => {
	it('knows the surfaces still in the Svelte app', () => {
		expect(svelteOnlySurface('/c/abc')).toBe('Chat');
		expect(svelteOnlySurface('/home')).toBe('Home');
		expect(svelteOnlySurface('/folders/f1')).toBe('Folders');
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
	it('links a Svelte-owned path to the Svelte app, keeping search and hash', () => {
		renderAt('/c/abc?x=1#m');
		expect(screen.getByRole('heading', { name: 'Chat is not in this app yet' })).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open it there' }).getAttribute('href')).toMatch(/\/c\/abc\?x=1#m$/);
	});
	it('shows a 404 for anything else', () => {
		renderAt('/typo');
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
	});
});
