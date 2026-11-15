import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { InterfaceSettings } from '@/components/settings/InterfaceSettings';
import { getUserSettings } from '@/lib/apis/users';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SettingsForm, useSavedFlash } from '../controls';

/** How long a run of changes (a font being typed, a slider dragged) waits before it is saved as one. */
export const SAVE_DELAY_MS = 400;

/**
 * Ports Settings/Interface.svelte: the shared InterfaceSettings (Phase 8) in
 * personal mode. It shows the effective values; a value that only comes from
 * the admin's defaults is marked as inherited (read from the user's own
 * settings, `?raw=true`).
 *
 * Saves at once (FRM-3, FRM-5; #951): each change is saved as it is made, a
 * burst of them together after SAVE_DELAY_MS, and the row says "Saved". What
 * is still waiting is saved when the tab closes, or on Enter.
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
	const { isSaved, flash } = useSavedFlash();
	// Taken once: a refetch after each save must not overwrite a field being typed in.
	const loaded = useRef(false);
	useEffect(() => {
		if (settings && !loaded.current) {
			loaded.current = true;
			setValues(settings as Record<string, unknown>);
		}
	}, [settings]);

	const waiting = useRef<Record<string, unknown>>({});
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const latest = useRef({ update, flash, queryClient });
	latest.current = { update, flash, queryClient };
	const flush = useCallback(() => {
		clearTimeout(timer.current);
		const patch = waiting.current;
		waiting.current = {};
		if (Object.keys(patch).length === 0) return;
		const { update, flash, queryClient } = latest.current;
		void update(patch).then(
			() => {
				flash(Object.keys(patch));
				void queryClient.invalidateQueries({ queryKey: ['user-settings-raw'] });
			},
			(e) => toast.error(`Couldn't save that setting: ${e instanceof Error ? e.message : e}`)
		);
	}, []);
	useEffect(() => flush, [flush]);

	const perms = (user?.permissions ?? {}) as { chat?: { temporary?: boolean } };
	const defaults = ((config as { ui?: { default_interface_settings?: Record<string, unknown> } } | null)?.ui
		?.default_interface_settings ?? {}) as Record<string, unknown>;

	return (
		<SettingsForm title="Interface" loading={!settings} savesAtOnce onSubmit={flush}>
			<InterfaceSettings
				mode="personal"
				values={values}
				onChange={(patch) => {
					setValues((v) => ({ ...v, ...patch }));
					waiting.current = { ...waiting.current, ...patch };
					clearTimeout(timer.current);
					timer.current = setTimeout(flush, SAVE_DELAY_MS);
				}}
				isSaved={isSaved}
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
