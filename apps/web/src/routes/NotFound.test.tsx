import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFound } from './NotFound';

describe('NotFound', () => {
	afterEach(() => vi.restoreAllMocks());
	const renderAt = (path: string) => render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <NotFound /> }], { initialEntries: [path] })} />);

	it('never navigates on its own (the old fallback looped on the dev server)', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		renderAt('/typo');
		expect(assign).not.toHaveBeenCalled();
	});
	it('shows a 404 naming the path', () => {
		renderAt('/typo');
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
		expect(screen.getByText('/typo')).toBeTruthy();
	});
});
