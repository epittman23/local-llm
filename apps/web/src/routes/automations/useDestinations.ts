import { useQuery } from '@tanstack/react-query';
import { getChannels } from '@/lib/apis/channels';
import { getFolders } from '@/lib/apis/folders';
import { useAuthStore } from '@/lib/stores/authStore';
import type { Channel, Folder } from './automationModel';

/**
 * The user's folders and channels, for choosing and naming where an
 * automation posts. In the Svelte app these are app-wide stores the sidebar
 * fills; here they are TanStack queries under `['folders']` and `['channels']`,
 * the keys the chat sidebar will share in Phase 10.
 */
export function useDestinations(enabled = true) {
	const token = useAuthStore((s) => s.token) ?? '';
	const folders = useQuery({ queryKey: ['folders'], queryFn: async () => ((await getFolders(token).catch(() => null)) ?? []) as Folder[], enabled, staleTime: 60_000 });
	const channels = useQuery({ queryKey: ['channels'], queryFn: async () => ((await getChannels(token).catch(() => null)) ?? []) as Channel[], enabled, staleTime: 60_000 });
	return { folders: folders.data ?? [], channels: channels.data ?? [], loaded: folders.isSuccess && channels.isSuccess };
}
