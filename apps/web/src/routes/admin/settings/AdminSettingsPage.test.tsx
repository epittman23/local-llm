import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingRow, SettingsForm, useSettingsHost } from '@/components/settings/controls';
import { useAuthStore } from '@/lib/stores/authStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { AdminAnalyticsPage, AdminSettingsPage } from './AdminSettingsPage';

const apis = vi.hoisted(() => ({ getPipelinesList: vi.fn() }));
vi.mock('@/lib/apis', async (importOriginal) => ({ ...(await importOriginal<object>()), ...apis }));

const loaders = vi.hoisted(() => ({
	'admin:general': vi.fn(),
	'admin:db': vi.fn(),
	'admin:pipelines': vi.fn(),
	'admin:analytics': vi.fn(),
	'admin:models': vi.fn()
}));
vi.mock('@/components/settings/adminTabComponents', () => ({
	tabLoaders: loaders,
	implementedTabIds: new Set(Object.keys(loaders))
}));

const tab = (text: string) => ({ default: () => <p>{text}</p> });

/** A server tab that saves on request, so leaving it dirty asks first. */
function DirtyTab() {
	const [value, setValue] = useState('');
	return (
		<SettingsForm title="General" dirty={value !== ''} onDiscard={() => setValue('')}>
			<SettingRow label="Name">
				<input aria-label="Draft" value={value} onChange={(e) => setValue(e.target.value)} />
			</SettingRow>
		</SettingsForm>
	);
}

/** A tab that shows its own back (an editor in place), as Admin > Models does. */
function OwnBackTab() {
	const host = useSettingsHost();
	const [own, setOwn] = useState(true);
	useEffect(() => {
		host.setOwnBack(own);
	}, [own, host]);
	return (
		<button type="button" onClick={() => setOwn(false)}>
			Close the editor
		</button>
	);
}

/** matchMedia answering the side-by-side query (min-width: 768px) as `wide`. */
const width = (wide: boolean) =>
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: wide,
		media: query,
		addEventListener() {},
		removeEventListener() {}
	}));

function mount(path: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: '/admin/settings', element: <AdminSettingsPage /> },
			{ path: '/admin/settings/:tab', element: <AdminSettingsPage /> },
			{ path: '/admin/analytics', element: <AdminAnalyticsPage /> },
			{ path: '/elsewhere', element: <p>elsewhere</p> }
		],
		{ initialEntries: [path] }
	);
	const view = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	render(view(<RouterProvider router={router} />));
	return router;
}

beforeEach(() => {
	for (const l of Object.values(loaders)) l.mockReset();
	loaders['admin:general'].mockResolvedValue({ default: DirtyTab });
	loaders['admin:db'].mockResolvedValue(tab('Database body'));
	loaders['admin:pipelines'].mockResolvedValue(tab('Pipelines body'));
	loaders['admin:analytics'].mockResolvedValue(tab('Analytics body'));
	loaders['admin:models'].mockResolvedValue({ default: OwnBackTab });
	apis.getPipelinesList.mockReset().mockResolvedValue([]);
	useAuthStore.setState({ token: 't', user: { id: 'u', name: 'U', email: 'u@x', role: 'admin' } } as never);
	width(true);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the server’s settings as pages under Admin (S5-D1, #932)', () => {
	it('opens the first tab from the bare address at 768 px and up, and titles the page by its tab', async () => {
		const router = mount('/admin/settings');
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/general'));
		expect(router.state.historyAction).toBe('REPLACE');
		expect(await screen.findByRole('textbox', { name: 'Draft' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-admin-general');
		expect(usePageTitleStore.getState().dynamic).toBe('General · Settings');
		expect(screen.getByRole('region', { name: 'Server settings' })).toBeInTheDocument();
	});

	it('names a tab plainly, in its list and its title, where the dialog said “Server:”', async () => {
		mount('/admin/settings/db');
		expect(await screen.findByText('Database body')).toBeInTheDocument();
		expect(usePageTitleStore.getState().dynamic).toBe('Database · Settings');
		expect(screen.getByRole('tab', { name: 'General' })).toHaveTextContent(/^General$/);
		expect(screen.queryByText('Server:', { exact: false })).toBeNull();
	});

	it('on a phone is two levels: the list, then the tab with a way back (#1000)', async () => {
		width(false);
		const router = mount('/admin/settings');
		const list = await screen.findByRole('tablist', { name: 'Settings' });
		expect(router.state.location.pathname).toBe('/admin/settings');
		expect(screen.queryByRole('tabpanel')).toBeNull();
		fireEvent.click(within(list).getByRole('tab', { name: 'Database' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/db'));
		expect(await screen.findByText('Database body')).toBeInTheDocument();
		expect(screen.getByRole('tablist', { name: 'Settings' }).parentElement).toHaveClass('max-md:hidden');
		const back = screen.getByRole('link', { name: 'All server settings' });
		expect(back).toHaveAttribute('href', '/admin/settings');
		expect(back.closest('a')).toHaveClass('md:hidden');
		fireEvent.click(back);
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings'));
	});

	it('on a phone shows one back at a time: none of its own while the tab shows one (#1030)', async () => {
		width(false);
		mount('/admin/settings/models');
		const close = await screen.findByRole('button', { name: 'Close the editor' });
		expect(screen.queryByRole('link', { name: 'All server settings' })).toBeNull();
		fireEvent.click(close);
		expect(await screen.findByRole('link', { name: 'All server settings' })).toBeInTheDocument();
	});

	it('sends a tab it does not know back to the list', async () => {
		width(false);
		const router = mount('/admin/settings/nope');
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings'));
		expect(router.state.historyAction).toBe('REPLACE');
	});

	it('lists Pipelines only while a pipelines server is connected (S5-D4)', async () => {
		const router = mount('/admin/settings/pipelines');
		await waitFor(() => expect(router.state.location.pathname).not.toBe('/admin/settings/pipelines'));
		expect(screen.queryByRole('tab', { name: 'Pipelines' })).toBeNull();
		expect(loaders['admin:pipelines']).not.toHaveBeenCalled();
		cleanup();

		apis.getPipelinesList.mockResolvedValue([{ url: 'http://127.0.0.1:9099', idx: 0 }]);
		mount('/admin/settings/pipelines');
		expect(await screen.findByText('Pipelines body')).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: 'Pipelines' })).toHaveAttribute('aria-selected', 'true');
	});

	it('searches the list, says what found nothing, and clears', async () => {
		mount('/admin/settings/db');
		await screen.findByText('Database body');
		const search = screen.getByRole('searchbox', { name: 'Search server settings' });
		fireEvent.change(search, { target: { value: 'database' } });
		expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Database']);
		fireEvent.change(search, { target: { value: 'zzqx' } });
		expect(screen.getByRole('status')).toHaveTextContent('No server settings match ‘zzqx’.');
		expect(screen.getByText('Database body')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(search).toHaveValue('');
		expect(screen.getAllByRole('tab').length).toBeGreaterThan(1);
	});

	it('clears its search on choosing a tab', async () => {
		const router = mount('/admin/settings/db');
		await screen.findByText('Database body');
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search server settings' }), {
			target: { value: 'general' }
		});
		fireEvent.click(screen.getByRole('tab', { name: 'General' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/general'));
		expect(screen.getByRole('searchbox', { name: 'Search server settings' })).toHaveValue('');
	});

	it('asks once before another tab or page while the open tab has unsaved changes (FRM-3, #951)', async () => {
		const router = mount('/admin/settings/general');
		fireEvent.change(await screen.findByRole('textbox', { name: 'Draft' }), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('tab', { name: 'Database' }));
		expect(await screen.findAllByRole('alertdialog', { name: 'Discard changes?' })).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(router.state.location.pathname).toBe('/admin/settings/general');

		await act(() => router.navigate('/elsewhere'));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
	});

	it('shows nothing to an account that is not an admin', async () => {
		useAuthStore.setState({ user: { id: 'u', name: 'U', email: 'u@x', role: 'user' } } as never);
		width(false);
		mount('/admin/settings');
		expect(await screen.findByText('No server settings to show.')).toBeInTheDocument();
		expect(apis.getPipelinesList).not.toHaveBeenCalled();
	});
});

describe('Analytics, an Admin tab of its own (S5-D1)', () => {
	it('renders the Analytics component as the page', async () => {
		mount('/admin/analytics');
		expect(await screen.findByText('Analytics body')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Analytics' })).toContainElement(screen.getByText('Analytics body'));
	});
});
