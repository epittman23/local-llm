import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { BenchmarksLayout } from './BenchmarksLayout';

const renderAt = (path: string) => {
	const router = createMemoryRouter(
		[{ path: '/benchmarks', element: <BenchmarksLayout />, children: [{ path: '*', element: <p>bench page</p> }] }],
		{ initialEntries: [path] }
	);
	render(<RouterProvider router={router} />);
};

afterEach(cleanup);

describe('BenchmarksLayout', () => {
	it('opens with the Benchmarks heading and the eight tabs, the open one current (LAY-5, NAV-1)', () => {
		useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role: 'admin' } } as never);
		useConfigStore.setState({ config: { name: 'local-llm', version: '0', features: { enable_benchmarks: true } } });
		renderAt('/benchmarks/prescreen');
		expect(screen.getByRole('heading', { level: 1, name: 'Benchmarks' })).toBeInTheDocument();
		const links = screen.getAllByRole('link');
		expect(links.map((l) => l.textContent)).toEqual([
			'Serve',
			'Live',
			'Tests',
			'Compare',
			'Answers',
			'Report',
			'Tune',
			'Pre-screen'
		]);
		expect(screen.getByRole('link', { name: 'Pre-screen' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByText('bench page')).toBeInTheDocument();
	});

	it('shows a skeleton, not "Loading…", while the session loads (STA-2)', () => {
		useAuthStore.setState({ status: 'pending', user: null } as never);
		useConfigStore.setState({ config: null });
		renderAt('/benchmarks/serve');
		expect(screen.getByRole('status').textContent).toBe('Loading benchmarks');
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
	});
});
