import { useCallback } from 'react';
import { toast } from 'sonner';
import { getBackendConfig } from '@/lib/apis';
import { useConfigStore } from '@/lib/stores/configStore';

/** `toast.success` the standard message. */
export const toastSaved = () => toast.success('Settings saved successfully!');

/**
 * Ports SettingsModal.svelte's `adminConfigSaveHandler`: after a tab saves a
 * setting that the rest of the app reads out of `/api/config` (feature flags,
 * upload limits, ...), say so and re-read that config into the store.
 */
export function useAdminConfigSaved() {
	const setConfig = useConfigStore((s) => s.setConfig);
	return useCallback(async () => {
		toastSaved();
		const fresh = await getBackendConfig().catch(() => null);
		if (fresh) setConfig(fresh);
	}, [setConfig]);
}
