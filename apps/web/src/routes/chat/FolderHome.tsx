import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Button } from '@/components/ui/button';
import { RowButton } from '@/components/ui/row-button';
import { getSharedFolders, updateFolderById } from '@/lib/apis/folders';
import type { Folder } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { shownTime } from '@/lib/utils/dates';
import { FolderDialog } from './sidebar/ChatDialogs';
import { FOLDER_PAGE_SIZE, useFolderChats } from './sidebar/useChatList';

/**
 * The page at /folders/:id (#998): a folder is a project, so its page says
 * which one. The folder's name is the page's h1 (A11Y-3, LAY-5) with Edit
 * folder beside it, its instructions folded under it, and its chats below,
 * each with its date. ChatPage shows it in place of the new-chat greeting,
 * above the message box, which reads "New chat in <folder>". Edit folder is
 * offered only to someone who may change it: its owner, an admin, or an
 * account it is shared with for writing (the server's own `permission` in
 * GET /folders/shared, which counts groups and parent folders).
 */
export function FolderHome({ folder }: { folder: Folder }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const chats = useFolderChats(folder.id, true);
	const list = chats.data?.pages.flat() ?? [];
	// Another page can exist only when the last one was full (the folder endpoint
	// pages by FOLDER_PAGE_SIZE), so a short folder offers no Show more (#1070).
	const more = chats.hasNextPage && (chats.data?.pages.at(-1)?.length ?? 0) >= FOLDER_PAGE_SIZE;
	const instructions = String(folder.data?.system_prompt ?? '').trim();
	const mine = user?.role === 'admin' || (Boolean(user) && folder.user_id === user?.id);
	const sharedFolders = useQuery({
		queryKey: ['folders', 'shared'],
		enabled: Boolean(token) && !mine,
		queryFn: async () => ((await getSharedFolders(token)) ?? []) as { id: string; permission?: string }[]
	});
	const canEdit = mine || Boolean(sharedFolders.data?.some((f) => f.id === folder.id && f.permission === 'write'));

	const save = async (v: { name: string; system_prompt: string }) => {
		const res = await updateFolderById(token, folder.id, {
			name: v.name,
			data: { ...(folder.data ?? {}), system_prompt: v.system_prompt }
		}).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (!res) return false;
		toast.success('Folder updated');
		void queryClient.invalidateQueries({ queryKey: ['folders'] });
		void queryClient.invalidateQueries({ queryKey: ['folder', folder.id] });
		return true;
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto" data-testid="folder-home">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
				<div className="flex flex-wrap items-start gap-3">
					<div className="min-w-0 flex-1">
						<h1 className="text-heading font-title truncate tracking-tight" title={folder.name}>
							{folder.name}
						</h1>
						<p className="text-foreground-muted mt-1">
							{instructions
								? 'A message sent below starts a chat in this folder, with its instructions.'
								: 'A message sent below starts a chat in this folder.'}
						</p>
					</div>
					{canEdit && (
						<Button variant="outline" onClick={() => setEditing(true)}>
							<Pencil aria-hidden /> Edit folder
						</Button>
					)}
				</div>

				{instructions && (
					<details className="border-border-divider rounded-lg border px-3 py-2">
						<summary className="text-body font-strong cursor-pointer">Instructions for chats in this folder</summary>
						<p className="text-foreground-muted mt-2 whitespace-pre-wrap">{instructions}</p>
					</details>
				)}

				<section aria-labelledby="folder-chats" className="flex flex-col gap-2">
					<h2 id="folder-chats" className="text-title font-title tracking-tight">
						Chats in this folder
					</h2>
					{chats.isError ? (
						<LoadFailed
							what="this folder's chats"
							error={chats.error}
							onRetry={() => void chats.refetch()}
							retrying={chats.isFetching}
						/>
					) : chats.isLoading ? (
						<div aria-hidden className="flex flex-col gap-1" data-testid="folder-chats-loading">
							{[0, 1, 2].map((i) => (
								<div key={i} className="bg-surface-3 h-9 animate-pulse rounded-lg" />
							))}
						</div>
					) : list.length === 0 ? (
						<p className="text-foreground-muted">No chats in this folder yet. Send a message below to start one.</p>
					) : (
						<ul className="flex flex-col">
							{list.map((chat) => {
								const time = chat.updated_at ? shownTime(chat.updated_at) : null;
								return (
									<li key={chat.id}>
										<RowButton className="flex items-center gap-3 px-3 py-2" onClick={() => navigate(`/c/${chat.id}`)}>
											<MessageSquare aria-hidden className="text-foreground-muted size-4 shrink-0" />
											<span className="min-w-0 flex-1 truncate" title={chat.title}>
												{chat.title}
											</span>
											{time && (
												<time
													dateTime={time.iso}
													title={time.exact}
													className="text-caption text-foreground-muted shrink-0"
												>
													{time.label}
												</time>
											)}
										</RowButton>
									</li>
								);
							})}
						</ul>
					)}
					{more && (
						<Button
							variant="ghost"
							className="self-start"
							disabled={chats.isFetchingNextPage}
							onClick={() => void chats.fetchNextPage()}
						>
							{chats.isFetchingNextPage ? 'Loading more chats…' : 'Show more chats'}
						</Button>
					)}
				</section>
			</div>
			<FolderDialog open={editing} onOpenChange={setEditing} folder={folder} onSave={save} />
		</div>
	);
}
