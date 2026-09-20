import { ChevronDown, ChevronUp, Clipboard, Link2Off, Search, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { deleteChatById } from '@/lib/apis/chats';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatNumber } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { sharePath } from '@/routes/routePaths';

export type ChatListItem = {
	id: string;
	title: string;
	updated_at: number;
	time_range?: string;
	share_id?: string | null;
	user_id?: string;
	user_name?: string;
};

const SortMark = ({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) =>
	active ? (
		direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" />
	) : (
		<ChevronUp className="invisible size-2" />
	);

/**
 * Ports layout/ChatsModal.svelte: a searchable, sortable, infinitely-scrolling
 * list of chats in a dialog. The Svelte component owns `chatList` through
 * two-way bindings; here the caller owns it and is told about changes
 * (`onDelete`, `onQueryChange`, `onSortChange`), which is what every caller
 * (admin User Chats now; Archived and Shared Chats in Phase 10) does with the
 * bindings anyway.
 *
 * `shareUrl` links rows to `/s/<id>` instead of `/c/<id>`. Clearing `query` when
 * the dialog closes is the caller's job (it owns `query`); it is done in the
 * one place a caller sees the close, `onOpenChange`.
 */
export function ChatsModal({
	open,
	onOpenChange,
	title = 'Chats',
	count = null,
	showSearch = true,
	showUserInfo = false,
	shareUrl = false,
	readOnly = false,
	query,
	onQueryChange,
	orderBy,
	direction,
	onSortChange,
	chatList,
	allChatsLoaded,
	chatListLoading,
	onDelete,
	onUpdate,
	loadHandler,
	unarchiveHandler,
	unshareHandler,
	footer
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title?: string;
	count?: number | null;
	showSearch?: boolean;
	showUserInfo?: boolean;
	shareUrl?: boolean;
	readOnly?: boolean;
	query: string;
	onQueryChange: (query: string) => void;
	orderBy: string;
	direction: 'asc' | 'desc';
	onSortChange: (orderBy: string, direction: 'asc' | 'desc') => void;
	chatList: ChatListItem[] | null;
	allChatsLoaded: boolean;
	chatListLoading: boolean;
	onDelete?: (id: string) => void;
	onUpdate?: () => void;
	loadHandler?: () => void;
	unarchiveHandler?: (id: string) => void;
	unshareHandler?: (id: string) => void;
	footer?: ReactNode;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [deleteId, setDeleteId] = useState<string | null>(null);

	useEffect(() => {
		if (!open) onQueryChange('');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const setSortKey = (key: string) => {
		if (orderBy === key) onSortChange(key, direction === 'asc' ? 'desc' : 'asc');
		else onSortChange(key, 'asc');
	};

	const deleteHandler = async (chatId: string) => {
		const res = await deleteChatById(token, chatId).catch((error) => {
			toast.error(`${error}`);
		});
		if (res) onDelete?.(chatId);
		onUpdate?.();
	};

	const sortHeader = (key: string, label: string, className: string) => (
		<button type="button" className={className} onClick={() => setSortKey(key)}>
			<div className="flex items-center gap-1.5">
				{label}
				<SortMark active={orderBy === key} direction={direction} />
			</div>
		</button>
	);

	return (
		<>
			<ConfirmDialog
				open={deleteId !== null}
				onOpenChange={(o) => !o && setDeleteId(null)}
				title="Delete chat?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleteId) deleteHandler(deleteId);
					setDeleteId(null);
				}}
			>
				This will permanently delete the chat.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="gap-0 p-0 sm:max-w-3xl" showCloseButton={false}>
					<div className="flex justify-between px-4 pt-3 pb-1">
						<DialogTitle className="flex items-center gap-2 text-sm font-medium">
							<span>{title}</span>
							{(count ?? chatList?.length) != null && (
								<span className="text-muted-foreground text-sm">{formatNumber(count ?? chatList?.length ?? 0)}</span>
							)}
						</DialogTitle>
						<DialogDescription className="sr-only">A list of chats.</DialogDescription>
						<button
							type="button"
							className="text-muted-foreground hover:bg-muted rounded-lg p-1 transition"
							aria-label="Close"
							onClick={() => onOpenChange(false)}
						>
							<X className="size-4" />
						</button>
					</div>

					<div className="flex w-full flex-col px-5 pb-4">
						{showSearch && (
							<div className="mt-0.5 mb-1.5 flex w-full space-x-2">
								<div className="flex flex-1 items-center">
									<Search className="mr-3 ml-1 size-4" />
									<input
										className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
										value={query}
										onChange={(e) => onQueryChange(e.target.value)}
										placeholder="Search Chats"
										aria-label="Search Chats"
										maxLength={500}
									/>
									{query && (
										<button
											type="button"
											className="hover:bg-muted mr-1 rounded-full p-0.5 transition"
											aria-label="Clear search"
											onClick={() => onQueryChange('')}
										>
											<X className="size-3" strokeWidth={2} />
										</button>
									)}
								</div>
							</div>
						)}

						{chatList ? (
							<div className="w-full">
								{chatList.length > 0 && (
									<div className="mb-1.5 flex text-xs font-normal">
										{showUserInfo && <div className="w-32 px-1.5 py-1">User</div>}
										{sortHeader('title', 'Title', `cursor-pointer px-1.5 py-1 select-none ${showUserInfo ? 'flex-1' : 'basis-3/5'} text-left`)}
										{sortHeader(
											'updated_at',
											'Updated at',
											`hidden cursor-pointer justify-end px-1.5 py-1 select-none sm:flex ${showUserInfo ? 'w-28' : 'sm:basis-2/5'}`
										)}
									</div>
								)}
								<div className="mb-3 max-h-[22rem] w-full overflow-y-scroll text-left text-sm">
									{chatList.length === 0 && (
										<div className="text-muted-foreground flex min-h-20 w-full items-center justify-center px-5 text-center text-xs">
											No results found
										</div>
									)}

									{chatList.map((chat, idx) => (
										<div key={chat.id}>
											{chat.time_range && (idx === 0 || chat.time_range !== chatList[idx - 1].time_range) && (
												<div className={`text-muted-foreground w-full px-2 pb-2 text-xs font-normal ${idx === 0 ? '' : 'pt-5'}`}>
													{chat.time_range}
												</div>
											)}
											<div className="hover:bg-muted/50 flex w-full items-center rounded-lg px-3 py-2 text-sm" draggable={false}>
												{showUserInfo && chat.user_id && (
													<div className="flex w-32 shrink-0 items-center gap-2">
														<img
															src={`${WEBUI_API_BASE_URL}/users/${chat.user_id}/profile/image`}
															alt={chat.user_name || 'User'}
															className="size-5 shrink-0 rounded-full object-cover"
														/>
														<span className="text-muted-foreground truncate text-xs">{chat.user_name || 'Unknown'}</span>
													</div>
												)}
												<Link
													className={showUserInfo ? 'flex-1' : 'basis-3/5'}
													to={shareUrl ? sharePath(chat.id) : `/c/${chat.id}`}
													onClick={() => onOpenChange(false)}
												>
													<div className="line-clamp-1 w-full text-ellipsis">{chat.title}</div>
												</Link>

												<div className={`${showUserInfo ? 'w-28' : 'basis-2/5'} flex items-center justify-end`}>
													<div className="text-muted-foreground hidden text-xs sm:flex">
														{dayjs(chat.updated_at * 1000).calendar(null, {
															sameDay: '[Today]',
															nextDay: '[Tomorrow]',
															nextWeek: 'dddd',
															lastDay: '[Yesterday]',
															lastWeek: '[Last] dddd',
															sameElse: 'L'
														})}
													</div>
													{!readOnly && (
														<div className="flex justify-end pl-2.5">
															{unarchiveHandler && (
																<Tip content="Unarchive Chat">
																	<button
																		type="button"
																		aria-label="Unarchive Chat"
																		className="w-fit self-center px-1 text-sm"
																		onClick={() => unarchiveHandler(chat.id)}
																	>
																		<ArchiveRestoreIcon />
																	</button>
																</Tip>
															)}
															{unshareHandler && chat.share_id && (
																<Tip content="Copy Share Link">
																	<button
																		type="button"
																		aria-label="Copy Share Link"
																		className="w-fit self-center px-1 text-sm"
																		onClick={async () => {
																			await navigator.clipboard.writeText(`${window.location.origin}/s/${chat.share_id}`);
																			toast.success('Share link copied to clipboard.');
																		}}
																	>
																		<Clipboard className="size-4" strokeWidth={1.5} />
																	</button>
																</Tip>
															)}
															<Tip content={unshareHandler ? 'Unshare Chat' : 'Delete Chat'}>
																<button
																	type="button"
																	aria-label={unshareHandler ? 'Unshare Chat' : 'Delete Chat'}
																	className="w-fit self-center px-1 text-sm"
																	onClick={() => (unshareHandler ? unshareHandler(chat.id) : setDeleteId(chat.id))}
																>
																	{unshareHandler ? <Link2Off className="size-4" /> : <Trash2 className="size-4" strokeWidth={1.5} />}
																</button>
															</Tip>
														</div>
													)}
												</div>
											</div>
										</div>
									))}

									{!allChatsLoaded && loadHandler && (
										<InfiniteLoader
											onVisible={() => {
												if (!chatListLoading) loadHandler();
											}}
										>
											<div className="flex w-full animate-pulse items-center justify-center gap-2 py-1 text-xs">
												<Spinner className="size-4" />
												<div>Loading...</div>
											</div>
										</InfiniteLoader>
									)}
								</div>
								{query === '' && footer}
							</div>
						) : (
							<div className="flex h-full min-h-20 w-full items-center justify-center">
								<Spinner className="size-5" />
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

// lucide has no single glyph for "box with an up arrow" that reads as unarchive.
const ArchiveRestoreIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-4">
		<path
			strokeLinecap="round"
			strokeLinejoin="round"
			d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3V15"
		/>
	</svg>
);
