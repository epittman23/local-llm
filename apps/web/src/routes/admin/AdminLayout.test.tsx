import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SubTabs } from './AdminLayout';

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
});
