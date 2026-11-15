import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/lib/stores/uiStore';
import { NotFound } from './NotFound';

describe('NotFound', () => {
	afterEach(() => vi.restoreAllMocks());
	const renderAt = (path: string) => {
		const router = createMemoryRouter(
			[
				{ path: '/', element: <p>home page</p> },
				{ path: '*', element: <NotFound /> }
			],
			{ initialEntries: [path] }
		);
		render(<RouterProvider router={router} />);
		return router;
	};

	it('never navigates on its own (the old fallback looped on the dev server)', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		const router = renderAt('/typo');
		expect(assign).not.toHaveBeenCalled();
		expect(router.state.location.pathname).toBe('/typo');
	});
	it('shows a 404 naming the path', () => {
		renderAt('/typo');
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
		expect(screen.getByText('/typo')).toBeTruthy();
	});
	it('is one h1 at the page-title size, inside the shell’s main rather than a main of its own (A11Y-3, TYP-2)', () => {
		renderAt('/typo');
		expect(screen.queryByRole('main')).toBeNull();
		const headings = screen.getAllByRole('heading', { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0].className).toContain('text-heading');
	});
	it('offers Go home and Search chats (NAV-3, #1069)', () => {
		useUIStore.setState({ searchOpen: false });
		renderAt('/typo');
		fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
		fireEvent.click(screen.getByRole('link', { name: 'Go home' }));
		expect(screen.getByText('home page')).toBeTruthy();
	});
});
