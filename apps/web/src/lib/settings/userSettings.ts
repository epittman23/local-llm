import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getUserSettings, updateUserSettings } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

// A small slice of the SvelteKit app's `settings` store: the user's saved UI
// settings (`GET /users/user/settings` -> { ui: {...} }), read through TanStack
// Query instead of a global writable. Only what a ported surface reads is
// typed; the object round-trips whole, because saving replaces `ui` outright
// (the API takes `{ ui: <everything> }`, so dropping unknown keys here would
// delete settings this app doesn't know about).
export type UserUiSettings = { pinnedModels?: string[]; [key: string]: unknown };

/**
 * Models shown in the sidebar. A user who has never pinned or unpinned follows
 * the admin's `default_pinned_models` (a comma-separated string), so changing
 * that default keeps reaching them; the moment they pin anything, their own list
 * (even an empty one) takes over.
 */
export function resolvePinnedModels(settings: UserUiSettings | null | undefined, defaultPinned: string | null | undefined): string[] {
	return settings?.pinnedModels === undefined ? (defaultPinned ?? '').split(',').filter((id) => id) : settings.pinnedModels;
}

const KEY = ['user-settings'];

export function useUserSettings() {
	const token = useAuthStore((s) => s.token) ?? '';
	const defaultPinned = useConfigStore((s) => s.config?.default_pinned_models);
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: KEY,
		enabled: Boolean(token),
		queryFn: async () => (((await getUserSettings(token))?.ui ?? {}) as UserUiSettings)
	});
	const pinnedModels = resolvePinnedModels(query.data, defaultPinned);

	const save = useMutation({
		mutationFn: (ui: UserUiSettings) => updateUserSettings(token, { ui }),
		// Optimistic: the pin shows at once and rolls back if the save fails.
		onMutate: async (ui) => {
			await queryClient.cancelQueries({ queryKey: KEY });
			const previous = queryClient.getQueryData(KEY);
			queryClient.setQueryData(KEY, ui);
			return { previous };
		},
		onError: (_e, _ui, ctx) => queryClient.setQueryData(KEY, ctx?.previous),
		onSettled: () => queryClient.invalidateQueries({ queryKey: KEY })
	});

	const togglePinned = (modelId: string) =>
		save.mutate({
			...(query.data ?? {}),
			pinnedModels: pinnedModels.includes(modelId) ? pinnedModels.filter((id) => id !== modelId) : [...pinnedModels, modelId]
		});

	return { settings: query.data ?? null, pinnedModels, togglePinned };
}
