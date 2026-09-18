import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyFallback, resolveLegacyFallback } from './LegacyFallback';

describe('resolveLegacyFallback', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('bounces to the same path via a full page navigation, not react-router', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});

		resolveLegacyFallback('/admin/users?tab=pending');

		expect(assign).toHaveBeenCalledExactlyOnceWith('/admin/users?tab=pending');
	});
});

describe('LegacyFallback', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('resolves the full unmatched path, including search and hash', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});

		const router = createMemoryRouter(
			[{ path: '*', element: <LegacyFallback /> }],
			{ initialEntries: ['/benchmarks/tune?run=42#top'] }
		);
		render(<RouterProvider router={router} />);

		expect(assign).toHaveBeenCalledExactlyOnceWith('/benchmarks/tune?run=42#top');
	});
});
