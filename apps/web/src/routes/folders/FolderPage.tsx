import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { getFolderById } from '@/lib/apis/folders';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';

type Folder = { id: string; name: string };

/**
 * Ports routes/(app)/folders/[folderId]: load the folder (a missing or
 * forbidden one says why and goes home, as before), then open a new chat
 * inside it. That chat is Phase 10's; until then the page names the folder
 * and says so. The sidebar's folder tree is part of the chat list and moves
 * with it in Phase 10.
 */
export function FolderPage() {
	const { folderId = '' } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const folder = useQuery({ queryKey: ['folder', folderId], retry: false, queryFn: async () => ((await getFolderById(token, folderId)) ?? null) as Folder | null });
	useDocumentTitle(folder.data?.name ?? 'Folder');

	useEffect(() => {
		if (folder.isError) toast.error(`${folder.error}`);
		if (folder.isError || (folder.isSuccess && !folder.data)) navigate('/', { replace: true });
	}, [folder.isError, folder.isSuccess, folder.data, folder.error, navigate]);

	if (!folder.data) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
			<h1 className="text-xl font-semibold">{folder.data.name}</h1>
			<p className="text-muted-foreground max-w-sm text-sm">Chatting inside a folder arrives with the chat itself, Phase 10 of the Astro/React migration.</p>
		</div>
	);
}
