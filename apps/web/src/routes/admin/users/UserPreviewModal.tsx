import { useQuery } from '@tanstack/react-query';
import { AccessPreview, type AccessPreviewData } from '@/components/common/AccessPreview';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getUserPreview } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';

/** Ports admin/UserPreviewModal.svelte: what a given user can reach, per their groups. */
export function UserPreviewModal({
	open,
	onOpenChange,
	userId,
	userName
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	userId: string;
	userName: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const query = useQuery({
		queryKey: ['admin', 'user-preview', userId],
		queryFn: () => getUserPreview(token, userId) as Promise<AccessPreviewData>,
		enabled: open && !!userId,
		gcTime: 0
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="min-w-0 truncate text-sm font-medium">
						User Preview
						{userName && <span className="text-muted-foreground ml-1 text-sm font-normal">{userName}</span>}
					</DialogTitle>
					<DialogDescription className="sr-only">Models, knowledge and tools this user can access.</DialogDescription>
				</DialogHeader>
				<AccessPreview
					loading={query.isPending}
					error={query.isError ? String(query.error) : ''}
					preview={query.data ?? null}
				/>
			</DialogContent>
		</Dialog>
	);
}
