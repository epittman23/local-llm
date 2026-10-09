import { useQuery } from '@tanstack/react-query';
import { getModels } from '@/lib/apis';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

export type ChatModel = {
	id: string;
	name: string;
	owned_by?: string;
	info?: {
		meta?: {
			hidden?: boolean;
			description?: string;
			profile_image_url?: string;
			capabilities?: Record<string, boolean>;
			suggestion_prompts?: { content: string; title?: string[] }[];
			tags?: { name: string }[];
		};
		params?: Record<string, unknown>;
		base_model_id?: string | null;
	};
	/** The Action functions attached to the model (the server resolves `meta.actionIds` into these): a button each under its replies. */
	actions?: { id: string; name: string; description?: string | null; icon?: string | null }[];
	[k: string]: unknown;
};

/** Every model the user can reach (the Svelte `models` store); shared with the Playground and the composers under ['models-all']. */
export function useModels() {
	const token = useAuthStore((s) => s.token) ?? '';
	const directEnabled = Boolean(
		(useConfigStore((s) => s.config?.features) as Record<string, unknown> | undefined)?.enable_direct_connections
	);
	const { settings } = useUserSettings();
	// The user's own OpenAI-compatible endpoints (Settings > Connections) are listed with the server's models.
	const direct = directEnabled
		? ((settings as { directConnections?: object } | null)?.directConnections ?? null)
		: null;
	const q = useQuery({
		queryKey: ['models-all'],
		enabled: Boolean(token),
		staleTime: 60_000,
		queryFn: async () => {
			const res = await getModels(token, direct);
			return (Array.isArray(res) ? res : []) as ChatModel[];
		}
	});
	return { models: q.data ?? [], loaded: q.isSuccess };
}
