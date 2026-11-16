import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { implementedTabIds } from '@/components/settings/adminTabComponents';
import { availableTabs, isAdminTab, serverTabPath } from '@/components/settings/settingsTabs';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { appHref } from '@/routes/routePaths';

/**
 * `?settings=<tab>`, the Settings modal's address (NAV-1). From
 * (app)/+layout.svelte's deep link, which opened the modal and then dropped
 * the parameter; now it stays while the modal is open, so a reload reopens
 * the same tab and Back closes it.
 *
 * - A `?settings=` that this hook did not write (a link, a reload,
 *   `/admin/settings/<tab>` redirecting here, Back or Forward) opens the modal
 *   on that tab. One the user cannot open -- an admin tab as a non-admin, or
 *   before any tab exists for them -- is dropped without opening anything.
 * - Opening Settings from the app adds a history entry; changing tab replaces
 *   it; closing goes back over the entry it added, or removes the parameter.
 * - Back removing the parameter closes the modal; with unsaved changes it puts
 *   the parameter back and asks "Discard changes?" instead (#951).
 * - A server tab (`?settings=admin:<tab>`, an old link or bookmark) is a page
 *   under Admin since S5-D1: the address is replaced with that page. The
 *   modal's own way there (`leaveTo`: a search result, "Server settings",
 *   `openSettings('admin:…')`) is a navigation that adds an entry.
 */
export function useSettingsUrl() {
	const [params, setParams] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();
	const requested = params.get('settings');
	const status = useAuthStore((s) => s.status);
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const open = useSettingsModalStore((s) => s.open);
	const tab = useSettingsModalStore((s) => s.tab);
	const leaveTo = useSettingsModalStore((s) => s.leaveTo);
	// Set while leaving for a page, so closing the modal does not also edit the address.
	const leaving = useRef(false);
	// The value this hook last put in the address, and the history entry it pushed.
	const written = useRef<string | null>(null);
	const pushed = useRef<{ key: string | null; pending: boolean }>({ key: null, pending: false });
	// The address as it is now, read (not watched) by the modal -> address effect.
	const now = useRef({ params, requested, key: location.key, pathname: location.pathname, setParams, navigate });
	now.current = { params, requested, key: location.key, pathname: location.pathname, setParams, navigate };

	// Address -> modal.
	useEffect(() => {
		if (status !== 'authenticated' || config === null) return;
		const store = useSettingsModalStore.getState();
		if (requested && requested !== written.current) {
			const allowed = !isAdminTab(requested) || user?.role === 'admin';
			if (allowed && isAdminTab(requested)) {
				const rest = new URLSearchParams(params);
				rest.delete('settings');
				const query = rest.toString();
				navigate(`${serverTabPath(requested)}${query ? `?${query}` : ''}`, { replace: true });
			} else if (allowed && availableTabs(user, config, implementedTabIds).length > 0) {
				written.current = requested;
				store.openSettings(requested);
			} else {
				const next = new URLSearchParams(params);
				next.delete('settings');
				setParams(next, { replace: true });
			}
		} else if (!requested && written.current !== null) {
			// The parameter went away without this hook: Back, or a link elsewhere.
			const was = written.current;
			written.current = null;
			pushed.current.key = null;
			if (!store.open) return;
			if (store.dirty) {
				written.current = was;
				const next = new URLSearchParams(params);
				next.set('settings', was);
				setParams(next);
				pushed.current.pending = true;
				store.requestClose();
			} else store.closeSettings();
		}
	}, [requested, status, user, config, params, setParams, navigate]);

	// The modal closed to go to a page (a server tab).
	useEffect(() => {
		if (!leaveTo) return;
		// Only a modal that wrote `?settings=` has a close for the next effect to skip.
		leaving.current = written.current !== null;
		useSettingsModalStore.getState().clearLeave();
		navigate(leaveTo);
	}, [leaveTo, navigate]);

	// The entry a push created: closing goes back over it.
	useEffect(() => {
		if (pushed.current.pending) {
			pushed.current = { key: location.key, pending: false };
		}
	}, [location.key]);

	// Modal -> address. Only the modal's state drives it.
	useEffect(() => {
		const { params, requested, setParams } = now.current;
		if (open && tab) {
			written.current = tab;
			if (requested === tab) return;
			const next = new URLSearchParams(params);
			next.set('settings', tab);
			if (requested) {
				// Replacing the entry this hook pushed keeps it the one closing goes back over.
				if (pushed.current.key !== null) pushed.current.pending = true;
				setParams(next, { replace: true });
			} else {
				pushed.current.pending = true;
				setParams(next);
			}
		} else if (!open && requested && requested === written.current) {
			// After the event that closed it has finished: a tab that closes Settings
			// and navigates elsewhere (Admin > Models' editor) has moved on by then,
			// and the address is left alone. The browser's address is checked too:
			// the router renders a navigation in a transition, so its location here
			// can still be the old one.
			const timer = setTimeout(() => {
				const { requested, key, pathname, params, setParams, navigate } = now.current;
				if (useSettingsModalStore.getState().open || requested !== written.current) return;
				if (leaving.current || window.location.pathname !== appHref(pathname)) {
					leaving.current = false;
					return;
				}
				written.current = null;
				if (pushed.current.key !== null && pushed.current.key === key) {
					pushed.current.key = null;
					navigate(-1);
				} else {
					const next = new URLSearchParams(params);
					next.delete('settings');
					setParams(next, { replace: true });
				}
			}, 0);
			return () => clearTimeout(timer);
		}
	}, [open, tab]);
}
