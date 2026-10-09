import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { InterfaceSettings } from '@/components/settings/InterfaceSettings';
import { getUserSettings } from '@/lib/apis/users';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SettingsForm } from '../controls';

/**
 * Ports Settings/Interface.svelte: the shared InterfaceSettings (Phase 8) in
 * personal mode. It shows the effective values; a value that only comes from
 * the admin's defaults is marked as inherited (read from the user's own
 * settings, `?raw=true`). Save stores every change.
 */
export default function Interface() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const queryClient = useQueryClient();
	const { settings, update } = useUserSettings();
	const raw = useQuery({
		queryKey: ['user-settings-raw'],
		queryFn: async () => ((await getUserSettings(token, true).catch(() => null))?.ui ?? {}) as Record<string, unknown>
	});
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (settings) setValues(settings as Record<string, unknown>);
	}, [settings]);

	const perms = (user?.permissions ?? {}) as { chat?: { temporary?: boolean } };
	const defaults = ((config as { ui?: { default_interface_settings?: Record<string, unknown> } } | null)?.ui
		?.default_interface_settings ?? {}) as Record<string, unknown>;

	return (
		<SettingsForm
			title="Interface"
			loading={!settings}
			saving={saving}
			onSubmit={async () => {
				setSaving(true);
				await update(values).then(
					() => toast.success('Settings saved successfully!'),
					(e) => toast.error(`${e}`)
				);
				void queryClient.invalidateQueries({ queryKey: ['user-settings-raw'] });
				setSaving(false);
			}}
		>
			<InterfaceSettings
				mode="personal"
				values={values}
				onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
				defaults={defaults}
				personal={raw.data ?? {}}
				isAdmin={user?.role === 'admin'}
				canTemporaryChat={user?.role === 'admin' || Boolean(perms.chat?.temporary)}
				autocompleteEnabled={Boolean(
					(config?.features as Record<string, unknown> | undefined)?.enable_autocomplete_generation
				)}
			/>
		</SettingsForm>
	);
}
