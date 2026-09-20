import { useQuery } from '@tanstack/react-query';
import { AccessPreview, type AccessPreviewData } from '@/components/common/AccessPreview';
import { getGroupPreview } from '@/lib/apis/groups';
import { useAuthStore } from '@/lib/stores/authStore';

/** Ports admin/Users/Groups/GroupPreviewPanel.svelte: what members of a group can reach. */
export function GroupPreviewPanel({ groupId }: { groupId: string }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const query = useQuery({
		queryKey: ['admin', 'group-preview', groupId],
		queryFn: () => getGroupPreview(token, groupId) as Promise<AccessPreviewData>,
		enabled: !!groupId,
		gcTime: 0
	});
	return <AccessPreview loading={query.isPending} error={query.isError ? String(query.error) : ''} preview={query.data ?? null} />;
}
