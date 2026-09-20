import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { implementedTabIds } from '@/components/settings/adminTabComponents';
import { availableTabs } from '@/components/settings/settingsTabs';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';

/**
 * The `?settings=<tab>` deep link, from (app)/+layout.svelte: open the Settings
 * modal on that tab, then drop the param (replacing the history entry, so Back
 * does not reopen it). `/admin/settings/<tab>` and `/admin/analytics` redirect
 * here. A request the user cannot open -- an admin tab as a non-admin, or before
 * any tab exists for them -- is dropped without opening anything.
 */
export function useSettingsUrl() {
	const [params, setParams] = useSearchParams();
	const requested = params.get('settings');
	const status = useAuthStore((s) => s.status);
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const openSettings = useSettingsModalStore((s) => s.openSettings);

	useEffect(() => {
		if (!requested || status !== 'authenticated' || config === null) return;
		if (availableTabs(user, config, implementedTabIds).length > 0) openSettings(requested);
		const next = new URLSearchParams(params);
		next.delete('settings');
		setParams(next, { replace: true });
	}, [requested, status, user, config, params, setParams, openSettings]);
}
