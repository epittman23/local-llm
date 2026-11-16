import { useQuery } from '@tanstack/react-query';
import { getPipelinesList } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';
import { implementedTabIds } from './adminTabComponents';
import { type SettingsTab, serverTabs } from './settingsTabs';

/**
 * The server tabs this user can open (`serverTabs`), with Pipelines listed
 * only while a pipelines server is connected (S5-D4). That is asked of the
 * server once and cached for five minutes, and only while `enabled`: the
 * answer makes the backend query every OpenAI connection.
 */
export function useServerTabs({ enabled = true }: { enabled?: boolean } = {}): {
	tabs: SettingsTab[];
	/** Whether a pipelines server is still being looked for (Pipelines may yet be listed). */
	pending: boolean;
} {
	const user = useAuthStore((s) => s.user);
	const token = useAuthStore((s) => s.token) ?? '';
	const admin = user?.role === 'admin';
	const pipelines = useQuery({
		queryKey: ['pipelines-detected'],
		enabled: enabled && admin && Boolean(token),
		staleTime: 5 * 60 * 1000,
		retry: false,
		queryFn: async () => ((await getPipelinesList(token)) as unknown[]).length > 0
	});
	return {
		tabs: serverTabs(user, implementedTabIds, { pipelines: pipelines.data === true }),
		pending: pipelines.isLoading
	};
}
