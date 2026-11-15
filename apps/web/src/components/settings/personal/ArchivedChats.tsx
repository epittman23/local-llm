import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ArchiveRestore, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	archiveChatById,
	deleteChatById,
	getAllArchivedChats,
	getArchivedChatList,
	unarchiveAllChats
} from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { ChatTime, SettingsForm } from '../controls';

type Row = { id: string; title: string; updated_at?: number };

/** GET /chats/archived answers 60 rows a page (routers/chats.py); a shorter page is the last. */
export const ARCHIVED_PAGE_SIZE = 60;

/**
 * Ports Settings/ArchivedChats.svelte: archived chats, searchable, newest
 * first, loading more on scroll; open, unarchive or delete one; unarchive
 * all; export them all as JSON. The title takes the free width (#954).
 * Below 640 px each row stacks (DAT-6): the title on a line of its own,
 * wrapped in full, with the date and the actions under it, so nothing
 * scrolls sideways (LAY-4). The explicit roles keep it a table to
 * assistive technology once its rows are laid out as grids.
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
			});
			return (Array.isArray(res) ? res : []) as Row[];
		},
		// Only a full page can have one after it: asking until a page came back
		// empty paged forever against a server that ignores `page`.
		getNextPageParam: (last, pages) => (last.length >= ARCHIVED_PAGE_SIZE ? pages.length + 1 : undefined)
	});
	const rows = (list.data?.pages ?? []).flat();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['chats'] });

	return (
		<SettingsForm title="Archived chats" footer={false}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<div className="relative min-w-48 flex-1">
					<Search aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search"
						aria-label="Search archived chats"
						className="pl-8"
					/>
				</div>
				<Button type="button" variant="outline" disabled={!rows.length} onClick={() => setUnarchiving(true)}>
					Unarchive all
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={async () =>
						saveAs(
							new Blob([JSON.stringify(await getAllArchivedChats(token))], { type: 'application/json' }),
							`archived-chat-export-${Date.now()}.json`
						)
					}
				>
					Export as JSON
				</Button>
			</div>
			{list.isError ? (
				<LoadFailed
					what="archived chats"
					error={list.error}
					onRetry={() => void list.refetch()}
					retrying={list.isRefetching}
				/>
			) : !list.isLoading && !rows.length ? (
				q ? (
					<div className="py-8 text-center">
						<p className="text-foreground-muted">No archived chats match “{q}”.</p>
						<Button type="button" variant="link" onClick={() => setQuery('')}>
							Clear search
						</Button>
					</div>
				) : (
					<p className="text-foreground-muted py-8 text-center">
						No archived chats. A chat you archive leaves the sidebar and is kept here.
					</p>
				)
			) : (
				<Table aria-label="Archived chats" role="table">
					<TableHeader role="rowgroup">
						<TableRow role="row" className="max-sm:sr-only">
							<TableHead scope="col" role="columnheader" className="w-full">
								Title
							</TableHead>
							<TableHead scope="col" role="columnheader" className="text-right">
								Updated
							</TableHead>
							<TableHead scope="col" role="columnheader">
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody role="rowgroup">
						{rows.map((c) => (
							<TableRow
								key={c.id}
								role="row"
								className="max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:py-1"
							>
								<TableCell
									role="cell"
									className="w-full max-w-0 truncate max-sm:col-span-2 max-sm:w-auto max-sm:max-w-none max-sm:pb-0 max-sm:break-words max-sm:whitespace-normal"
									title={c.title}
								>
									<Link to={`/c/${c.id}`} className="hover:underline" onClick={closeSettings}>
										{c.title}
									</Link>
								</TableCell>
								<TableCell
									role="cell"
									className="text-foreground-muted text-right text-dense tabular-nums max-sm:text-left"
								>
									<ChatTime seconds={c.updated_at} />
								</TableCell>
								<TableCell role="cell" className="text-right">
									<div className="flex items-center justify-end gap-1">
										<Button variant="ghost" size="sm" asChild>
											<Link to={`/c/${c.id}`} onClick={closeSettings} aria-label={`Open ${c.title}`}>
												Open
											</Link>
										</Button>
										<Tip content="Unarchive">
											<Button
												variant="ghost"
												size="icon-sm"
												type="button"
												aria-label={`Unarchive ${c.title}`}
												onClick={async () => {
													await archiveChatById(token, c.id).then(
														() => toast.success('Chat unarchived'),
														(e) => toast.error(`${e}`)
													);
													void refresh();
												}}
											>
												<ArchiveRestore aria-hidden />
											</Button>
										</Tip>
										<Tip content="Delete">
											<Button
												variant="ghost"
												size="icon-sm"
												type="button"
												aria-label={`Delete ${c.title}`}
												onClick={() => setDeleting(c)}
											>
												<Trash2 aria-hidden />
											</Button>
										</Tip>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{list.hasNextPage && <InfiniteLoader onVisible={() => !list.isFetchingNextPage && void list.fetchNextPage()} />}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete “${deleting?.title ?? ''}”?`}
				confirmLabel="Delete chat"
				onConfirm={async () => {
					if (deleting)
						await deleteChatById(token, deleting.id).then(
							() => toast.success('Chat deleted'),
							(e) => toast.error(`${e}`)
						);
					void refresh();
				}}
			>
				The chat and its messages are deleted for good.
			</ConfirmDialog>
			<ConfirmDialog
				open={unarchiving}
				onOpenChange={setUnarchiving}
				title="Unarchive all chats?"
				confirmLabel="Unarchive all"
				onConfirm={async () => {
					await unarchiveAllChats(token).then(
						() => toast.success('All chats unarchived'),
						(e) => toast.error(`${e}`)
					);
					void refresh();
				}}
			>
				Every archived chat goes back to the sidebar.
			</ConfirmDialog>
		</SettingsForm>
	);
}
