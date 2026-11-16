import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { AdminLayout, SubTabs } from './AdminLayout';

afterEach(cleanup);

const TABS = [
	{ id: 'overview', to: '/admin/users', label: 'Overview', count: '12' },
	{ id: 'groups', to: '/admin/users/groups', label: 'Groups' }
];

const renderTabs = (active: string) =>
	render(
		<MemoryRouter>
			<SubTabs tabs={TABS} active={active} />
		</MemoryRouter>
	);

describe('SubTabs', () => {
	it('links each tab to its route', () => {
		renderTabs('overview');
		expect(screen.getByRole('link', { name: /Overview/ }).getAttribute('href')).toBe('/admin/users');
		expect(screen.getByRole('link', { name: 'Groups' }).getAttribute('href')).toBe('/admin/users/groups');
	});

	it('mutes the tabs that are not active', () => {
		renderTabs('overview');
		expect(screen.getByRole('link', { name: 'Groups' }).className).toContain('text-foreground-muted');
		expect(screen.getByRole('link', { name: /Overview/ }).className).not.toContain('text-foreground-muted');
	});

	it('shows a tab count only when one is given', () => {
		renderTabs('groups');
		expect(screen.getByRole('link', { name: /Overview/ }).textContent).toContain('12');
		expect(screen.getByRole('link', { name: 'Groups' }).textContent).toBe('Groups');
	});

	it('draws a count in the muted colour, not by fading the text (COL-2)', () => {
		renderTabs('overview');
		const count = screen.getByText('12');
		expect(count.className).toContain('text-muted-foreground');
		expect(count.className).not.toContain('opacity');
	});
});

describe('AdminLayout', () => {
	const renderAt = (path: string, plugins = true, analytics = true) => {
		useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role: 'admin' } } as never);
		useConfigStore.setState({
			config: {
				name: 'local-llm',
				version: '0',
				features: { enable_plugins: plugins, enable_admin_analytics: analytics }
			}
		});
		const router = createMemoryRouter(
			[{ path: '/admin', element: <AdminLayout />, children: [{ path: '*', element: <p>admin page</p> }] }],
			{ initialEntries: [path] }
		);
		render(<RouterProvider router={router} />);
		return router;
	};

	it('opens with the Admin heading over its tabs, Users current on any users page (LAY-5, NAV-1)', () => {
		renderAt('/admin/users/overview');
		expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Users' }).getAttribute('href')).toBe('/admin');
		expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
		expect(screen.getByText('admin page')).toBeInTheDocument();
	});

	it('gives the function editor the height on a phone: the header and tabs hide below sm, the h1 stays for screen readers (LAY-4)', () => {
		renderAt('/admin/functions/create');
		expect(screen.getByRole('navigation', { name: 'Admin' }).closest('.max-sm\\:hidden')).not.toBeNull();
		expect(document.querySelector('h1.sr-only')).toHaveTextContent('Admin');
		cleanup();
		renderAt('/admin/functions');
		expect(screen.getByRole('navigation', { name: 'Admin' }).closest('.max-sm\\:hidden')).toBeNull();
		expect(document.querySelector('h1.sr-only')).toBeNull();
	});

	it('offers Functions only while plugins are on', () => {
		renderAt('/admin/evaluations/leaderboard', false);
		expect(screen.getByRole('link', { name: 'Evaluations' }).getAttribute('aria-current')).toBe('page');
		expect(screen.queryByRole('link', { name: 'Functions' })).toBeNull();
	});

	it('has an Analytics tab between Evaluations and Functions while admin analytics is on (S5-D1)', () => {
		renderAt('/admin/analytics');
		const names = screen
			.getAllByRole('link')
			.map((l) => l.textContent)
			.filter((n) => n !== 'admin page');
		expect(names).toEqual(['Users', 'Evaluations', 'Analytics', 'Functions', 'Settings']);
		expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('link', { name: 'Analytics' }).getAttribute('href')).toBe('/admin/analytics');
	});

	it('hides Analytics while it is off, and sends its address to /admin', async () => {
		const router = renderAt('/admin/analytics', true, false);
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
		expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
	});

	it('makes Settings current on a server settings page, which stays in Admin', () => {
		renderAt('/admin/settings/connections');
		expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/admin/settings');
	});

	it('shows a skeleton, not "Loading…", until the session settles (STA-2)', () => {
		useAuthStore.setState({ status: 'pending', user: null } as never);
		useConfigStore.setState({ config: null });
		const router = createMemoryRouter([{ path: '/admin/*', element: <AdminLayout /> }], {
			initialEntries: ['/admin/users']
		});
		render(<RouterProvider router={router} />);
		expect(screen.getByRole('status').textContent).toBe('Loading admin');
	});
});
