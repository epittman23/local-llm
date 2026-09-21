import { ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Spinner } from '@/components/common/Spinner';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { dayjs } from '@/lib/utils/dates';
import { sharePath } from '@/routes/routePaths';

export type ChatListSort = 'title' | 'updated_at' | 'user_name';
export type ChatRow = { id: string; title: string; updated_at: number; user_id?: string; user_name?: string; time_range?: string };

const Mark = ({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) =>
	active ? direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" /> : <ChevronUp className="invisible size-2" />;

/**
 * Ports common/ChatList.svelte: the read-only chat list used inside dialogs --
 * optional user column, sortable headers when `onSort` is given, "Today 3:04 PM"
 * style dates, and infinite loading through `onLoadMore`. (ChatsModal is the
 * heavier cousin with search and delete.)
 */
export function ChatList({
	chatList,
	loading = false,
	allLoaded = false,
	showUserInfo = false,
	shareUrl = false,
	emptyMessage = 'No chats found',
	onLoadMore,
	onChatClick,
	orderBy,
	direction = 'desc',
	onSort
}: {
	chatList: ChatRow[] | null;
	loading?: boolean;
	allLoaded?: boolean;
	showUserInfo?: boolean;
	shareUrl?: boolean;
	emptyMessage?: string;
	onLoadMore?: () => void;
	onChatClick?: (id: string) => void;
	orderBy?: ChatListSort | null;
	direction?: 'asc' | 'desc';
	onSort?: (key: ChatListSort) => void;
}) {
	const header = (key: ChatListSort, label: string, className: string) =>
		onSort ? (
			<button type="button" className={`${className} cursor-pointer select-none`} onClick={() => onSort(key)}>
				<div className="flex items-center gap-1.5">
					{label}
					<Mark active={orderBy === key} direction={direction} />
				</div>
			</button>
		) : (
			<div className={className}>{label}</div>
		);

	return (
		<div className="w-full">
			{chatList && chatList.length > 0 && (
				<div className="mb-1.5 flex text-xs font-normal">
					{showUserInfo && header('user_name', 'User', 'w-32 px-1.5 py-1 text-left')}
					{header('title', 'Title', `${showUserInfo ? 'flex-1' : 'basis-3/5'} px-1.5 py-1 text-left`)}
					{header('updated_at', 'Updated at', `hidden justify-end px-1.5 py-1 sm:flex ${showUserInfo ? 'w-28' : 'sm:basis-2/5'}`)}
				</div>
			)}
			<div className="max-h-[22rem] w-full overflow-y-auto text-left text-sm">
				{loading && (!chatList || chatList.length === 0) ? (
					<div className="flex min-h-20 items-center justify-center">
						<Spinner />
					</div>
				) : !chatList || chatList.length === 0 ? (
					<div className="text-muted-foreground flex min-h-20 items-center justify-center px-5 text-center text-xs">{emptyMessage}</div>
				) : (
					<>
						{chatList.map((chat, idx) => (
							<div key={chat.id}>
								{chat.time_range && (idx === 0 || chat.time_range !== chatList[idx - 1]?.time_range) && (
									<div className={`text-muted-foreground w-full px-2 pb-2 text-xs ${idx === 0 ? '' : 'pt-5'}`}>{chat.time_range}</div>
								)}
								<div className="hover:bg-muted/50 flex w-full items-center rounded-lg px-3 py-2 text-sm">
									{showUserInfo && chat.user_id && (
										<div className="flex w-32 shrink-0 items-center gap-2">
											<img src={`${WEBUI_API_BASE_URL}/users/${chat.user_id}/profile/image`} alt={chat.user_name || 'User'} className="size-5 shrink-0 rounded-full object-cover" />
											<span className="text-muted-foreground truncate text-xs">{chat.user_name || 'Unknown'}</span>
										</div>
									)}
									<Link className={showUserInfo ? 'flex-1' : 'basis-3/5'} to={shareUrl ? sharePath(chat.id) : `/c/${chat.id}`} onClick={() => onChatClick?.(chat.id)}>
										<div className="line-clamp-1 w-full text-ellipsis">{chat.title}</div>
									</Link>
									<div className={`${showUserInfo ? 'w-28' : 'basis-2/5'} flex items-center justify-end`}>
										<div className="text-muted-foreground hidden text-xs sm:flex">
											{dayjs(chat.updated_at * 1000).calendar(null, { sameDay: '[Today] h:mm A', lastDay: '[Yesterday] h:mm A', lastWeek: 'MMM D', sameElse: 'MMM D, YYYY' })}
										</div>
									</div>
								</div>
							</div>
						))}
						{!allLoaded && onLoadMore && (
							<InfiniteLoader onVisible={() => !loading && onLoadMore()}>
								<div className="flex w-full animate-pulse items-center justify-center gap-2 py-1 text-xs">
									<Spinner className="size-4" />
									<div>Loading...</div>
								</div>
							</InfiniteLoader>
						)}
					</>
				)}
			</div>
		</div>
	);
}
