import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ArchiveRestore, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	archiveChatById,
	deleteChatById,
	getAllArchivedChats,
	getArchivedChatList,
	unarchiveAllChats
} from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { SettingsForm } from '../controls';

type Row = { id: string; title: string; updated_at?: number };

/**
 * Ports Settings/ArchivedChats.svelte: archived chats, searchable, newest
 * first, loading more on scroll; open, unarchive or delete one; unarchive
 * all; export them all as JSON.
 */
export default function ArchivedChats() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const closeSettings = useSettingsModalStore((s) => s.closeSettings);
	const [query, setQuery] = useState('');
	const q = useDebouncedValue(query.trim(), 300);
	const [deleting, setDeleting] = useState<Row | null>(null);
	const [unarchiving, setUnarchiving] = useState(false);
	const list = useInfiniteQuery({
		queryKey: ['chats', 'archived', q],
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => {
			const res = await getArchivedChatList(token, pageParam, {
				...(q ? { query: q } : {}),
				order_by: 'updated_at',
				direction: 'desc'
			}).catch(() => null);
			return (Array.isArray(res) ? res : []) as Row[];
		},
		getNextPageParam: (last, pages) => (last.length ? pages.length + 1 : undefined)
	});
	const rows = (list.data?.pages ?? []).flat();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['chats'] });

	return (
		<SettingsForm title="Archived Chats" footer={false}>
			<div className="mb-2 flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="text-muted-foreground absolute top-2 left-2 size-3.5" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search"
						aria-label="Search archived chats"
						className="h-7 pl-7 text-xs"
					/>
				</div>
				<Button type="button" size="sm" variant="outline" disabled={!rows.length} onClick={() => setUnarchiving(true)}>
					Unarchive All
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={async () =>
						saveAs(
							new Blob([JSON.stringify(await getAllArchivedChats(token))], { type: 'application/json' }),
							`archived-chat-export-${Date.now()}.json`
						)
					}
				>
					Export
				</Button>
			</div>
			{!list.isLoading && !rows.length ? (
				<p className="text-muted-foreground py-6 text-center text-sm">You have no archived conversations.</p>
			) : (
				<table className="w-full text-sm">
					<thead className="text-muted-foreground text-left text-xs">
						<tr>
							<th className="py-1 font-normal">Title</th>
							<th className="py-1 font-normal">Updated at</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{rows.map((c) => (
							<tr key={c.id} className="border-t">
								<td className="max-w-0 truncate py-1.5 pr-2">
									<Link to={`/c/${c.id}`} className="hover:underline" onClick={closeSettings}>
										{c.title}
									</Link>
								</td>
								<td className="text-muted-foreground py-1.5 text-xs whitespace-nowrap">
									{c.updated_at ? dayjs(c.updated_at * 1000).format('LLL') : ''}
								</td>
								<td className="py-1.5 text-right whitespace-nowrap">
									<button
										type="button"
										aria-label={`Unarchive ${c.title}`}
										className="hover:bg-muted rounded p-1"
										onClick={async () => {
											await archiveChatById(token, c.id).catch((e) => toast.error(`${e}`));
											void refresh();
										}}
									>
										<ArchiveRestore className="size-3.5" />
									</button>
									<button
										type="button"
										aria-label={`Delete ${c.title}`}
										className="hover:bg-muted rounded p-1"
										onClick={() => setDeleting(c)}
									>
										<Trash2 className="size-3.5" />
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{list.hasNextPage && <InfiniteLoader onVisible={() => !list.isFetchingNextPage && void list.fetchNextPage()} />}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete chat?"
				confirmLabel="Delete"
				onConfirm={async () => {
					if (deleting) await deleteChatById(token, deleting.id).catch((e) => toast.error(`${e}`));
					void refresh();
				}}
			>
				This will delete <strong>{deleting?.title}</strong>.
			</ConfirmDialog>
			<ConfirmDialog
				open={unarchiving}
				onOpenChange={setUnarchiving}
				title="Unarchive All"
				confirmLabel="Unarchive All"
				onConfirm={async () => {
					await unarchiveAllChats(token).then(
						() => toast.success('All chats have been unarchived.'),
						(e) => toast.error(`${e}`)
					);
					void refresh();
				}}
			>
				Are you sure you want to unarchive all archived chats?
			</ConfirmDialog>
		</SettingsForm>
	);
}
