import { act, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { useSettingsUrl } from './useSettingsUrl';

function Host() {
	useSettingsUrl();
	return null;
}

/** A page with unsaved changes under the shell, as an Admin settings tab is (`SettingsPageHost`). */
function DirtyPageHost() {
	useSettingsUrl();
	return useUnsavedChanges(true).dialog;
}

const store = () => useSettingsModalStore.getState();

function mount(path: string, element = <Host />) {
	const router = createMemoryRouter([{ path: '*', element }], {
		initialEntries: ['/start', path],
		initialIndex: 1
	});
	// '/start' has no route of its own; it only gives Back somewhere to go.
	render(<RouterProvider router={router} />);
	return router;
}
const settingsParam = (router: ReturnType<typeof createMemoryRouter>) =>
	new URLSearchParams(router.state.location.search).get('settings');

/** What SettingsModal does on open: resolve the request into the open tab. */
const modalResolves = () => act(() => store().setTab(store().requestedTab ?? 'general'));

beforeEach(() => {
	useAuthStore.setState({ status: 'authenticated', user: { id: 'u', name: 'U', role: 'admin' } } as never);
	useConfigStore.setState({ config: { name: 'x', version: '1', features: {} } } as never);
});
afterEach(() => act(() => store().closeSettings()));

describe('?settings= while the modal is open (NAV-1)', () => {
	it('a deep link opens that tab and stays in the address; a tab change replaces it', async () => {
		const router = mount('/?settings=interface');
		await waitFor(() => expect(store().open).toBe(true));
		expect(store().requestedTab).toBe('interface');
		modalResolves();
		expect(settingsParam(router)).toBe('interface');
		act(() => store().setTab('notifications'));
		await waitFor(() => expect(settingsParam(router)).toBe('notifications'));
		expect(router.state.historyAction).toBe('REPLACE');
	});

	it('closing a deep-linked modal removes the parameter and does not reopen it', async () => {
		const router = mount('/?settings=interface');
		await waitFor(() => expect(store().open).toBe(true));
		modalResolves();
		act(() => store().closeSettings());
		await waitFor(() => expect(settingsParam(router)).toBeNull());
		expect(store().open).toBe(false);
		expect(router.state.location.pathname).toBe('/');
	});

	it('opened from the app, it adds an entry, and Back closes it', async () => {
		const router = mount('/');
		act(() => store().openSettings());
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
		expect(router.state.historyAction).toBe('PUSH');
		await act(() => router.navigate(-1));
		await waitFor(() => expect(store().open).toBe(false));
		expect(settingsParam(router)).toBeNull();
	});

	it('opened from the app, closing goes back over the entry it added', async () => {
		const router = mount('/');
		act(() => store().openSettings());
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
		act(() => store().setTab('interface'));
		await waitFor(() => expect(settingsParam(router)).toBe('interface'));
		act(() => store().closeSettings());
		await waitFor(() => expect(router.state.historyAction).toBe('POP'));
		expect(settingsParam(router)).toBeNull();
		expect(store().open).toBe(false);
	});

	it('Back with unsaved changes puts the parameter back and asks first (#951)', async () => {
		const router = mount('/');
		act(() => store().openSettings());
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
		act(() => store().setDirty(true));
		await act(() => router.navigate(-1));
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
		expect(store().open).toBe(true);
		expect(store().pending).toEqual({ kind: 'close' });
	});

	it('opens and closes over a page with unsaved changes without its guard asking, address in step', async () => {
		// At '/', the address jsdom's window holds, as the close check reads it.
		const router = mount('/', <DirtyPageHost />);
		act(() => store().openSettings('account'));
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('account'));
		expect(store().open).toBe(true);
		expect(screen.queryByRole('alertdialog')).toBeNull();
		act(() => store().setTab('interface'));
		await waitFor(() => expect(settingsParam(router)).toBe('interface'));
		act(() => store().closeSettings());
		await waitFor(() => expect(settingsParam(router)).toBeNull());
		expect(router.state.location.pathname).toBe('/');
		expect(store().open).toBe(false);
		expect(screen.queryByRole('alertdialog')).toBeNull();
		// Back from a reopened dialog closes it too, without asking.
		act(() => store().openSettings('account'));
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('account'));
		await act(() => router.navigate(-1));
		await waitFor(() => expect(store().open).toBe(false));
		expect(settingsParam(router)).toBeNull();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('drops an admin tab a non-admin asked for, without opening anything', async () => {
		useAuthStore.setState({ user: { id: 'u', name: 'U', role: 'user' } } as never);
		const router = mount('/?settings=admin:db');
		await waitFor(() => expect(settingsParam(router)).toBeNull());
		expect(store().open).toBe(false);
	});
});

describe('a server tab, a page under Admin since S5-D1 (#932)', () => {
	it('an old ?settings=admin:<tab> link is replaced with its page, keeping other parameters', async () => {
		const router = mount('/?x=1&settings=admin:db');
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/db'));
		expect(router.state.location.search).toBe('?x=1');
		expect(router.state.historyAction).toBe('REPLACE');
		expect(store().open).toBe(false);
	});

	it('an id that is not a server tab goes to the list, never an odd path', async () => {
		for (const id of ['admin:a/b', 'admin:../..']) {
			const router = mount(`/?settings=${encodeURIComponent(id)}`);
			await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings'));
			expect(router.state.location.search).toBe('');
		}
	});

	it('?settings=admin:analytics goes to the Analytics tab', async () => {
		const router = mount('/?settings=admin:analytics');
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/analytics'));
		expect(router.state.location.search).toBe('');
	});

	it('leaving the open modal for a page adds an entry there and leaves the address alone', async () => {
		const router = mount('/');
		act(() => store().openSettings());
		modalResolves();
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
		act(() => store().requestLeave('/admin/settings'));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings'));
		expect(router.state.historyAction).toBe('PUSH');
		expect(store()).toMatchObject({ open: false, leaveTo: null });
		await act(() => new Promise((r) => setTimeout(r, 10)));
		expect(router.state.location.pathname).toBe('/admin/settings');
		await act(() => router.navigate(-1));
		await waitFor(() => expect(settingsParam(router)).toBe('general'));
	});

	it('a server tab asked for while Settings is closed goes straight to its page', async () => {
		const router = mount('/c/1');
		act(() => store().openSettings('admin:code-execution'));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/code-execution'));
		expect(store().open).toBe(false);
	});
});
