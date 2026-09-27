import { useQuery } from '@tanstack/react-query';
import { getModels } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';

export type ChatModel = {
	id: string;
	name: string;
	owned_by?: string;
	info?: { meta?: { hidden?: boolean; description?: string; profile_image_url?: string; capabilities?: Record<string, boolean>; suggestion_prompts?: { content: string; title?: string[] }[]; tags?: { name: string }[] }; params?: Record<string, unknown>; base_model_id?: string | null };
	[k: string]: unknown;
};

/** Every model the user can reach (the Svelte `models` store); shared with the Playground and the composers under ['models-all']. */
export function useModels() {
	const token = useAuthStore((s) => s.token) ?? '';
	const q = useQuery({ queryKey: ['models-all'], enabled: Boolean(token), staleTime: 60_000, queryFn: async () => {
			const res = await getModels(token);
			return (Array.isArray(res) ? res : []) as ChatModel[];
		}
	});
	return { models: q.data ?? [], loaded: q.isSuccess };
}
