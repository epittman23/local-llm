import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, Lock, Pin, User, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { getChannelById } from '@/lib/apis/channels';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useSocket } from '@/lib/socket/SocketProvider';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { ChannelInfoDialog, PinnedMessagesDialog } from './ChannelDialogs';
import { type Channel, type ChannelMessage, channelTitle, isPublicChannel } from './channelModel';
import { type ComposerHandle, MessageComposer } from './MessageComposer';
import { MessageList } from './MessageList';
import { ThreadPanel } from './ThreadPanel';
import { useMarkChannelRead, useOpenChannelStore } from './useChannels';
import { useMessageFeed } from './useMessageFeed';

const headerButton = 'text-muted-foreground hover:bg-muted flex items-center gap-1 rounded-xl border px-1.5 py-1 text-sm transition';

function useLargeScreen() {
	const query = '(min-width: 1024px)';
	const [large, setLarge] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
	useEffect(() => {
		const mq = window.matchMedia?.(query);
		if (!mq) return;
		const on = (e: MediaQueryListEvent) => setLarge(e.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	}, []);
	return large;
}

/** Ports routes/(app)/channels/[id]: keyed by id, so moving between channels starts each one fresh. */
export function ChannelPage() {
	const { id = '' } = useParams();
	return (
		<FeatureGate feature="channels">
			<ChannelView key={id} id={id} />
		</FeatureGate>
	);
}

/**
 * Ports channel/Channel.svelte and channel/Navbar.svelte: the header (name,
 * pinned messages, members), the live message list, the composer, and a
 * thread beside the list on a wide screen or in a sheet on a narrow one.
 * Opening a channel marks it read, on the server (a `last_read_at` socket
 * event) and in the sidebar; so does typing in it, and leaving it.
 *
 * The thread panel is a fixed 420px, where the Svelte one could be dragged
 * wider; nothing else about the layout depends on its width.
 */
function ChannelView({ id }: { id: string }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const me = useAuthStore((s) => s.user);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { socket } = useSocket();
	const setOpenChannelId = useOpenChannelStore((s) => s.setOpenChannelId);
	const markChannelRead = useMarkChannelRead();
	const largeScreen = useLargeScreen();

	const channelQuery = useQuery({ queryKey: ['channel', id], queryFn: async () => ((await getChannelById(token, id)) ?? null) as Channel | null, retry: false });
	const channel = channelQuery.data ?? null;
	const [threadId, setThreadId] = useState<string | null>(null);
	const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
	const [showPinned, setShowPinned] = useState(false);
	const [showInfo, setShowInfo] = useState(false);
	const composer = useRef<ComposerHandle>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);

	const feed = useMessageFeed(id, null, { onMessageDeleted: (deleted) => setThreadId((t) => (t === deleted ? null : t)) });

	useDocumentTitle(channel ? (channel.type === 'dm' ? channelTitle(channel, me?.id) : `#${channel.name}`) : 'Channel');

	useEffect(() => {
		if (channelQuery.isError || (channelQuery.isSuccess && !channel)) navigate('/', { replace: true });
	}, [channelQuery.isError, channelQuery.isSuccess, channel, navigate]);

	const readRef = useRef<() => void>(() => {});
	readRef.current = () => {
		socket?.emit('events:channel', { channel_id: id, message_id: null, data: { type: 'last_read_at' } });
		markChannelRead(id);
	};
	useEffect(() => {
		setOpenChannelId(id);
		readRef.current();
		return () => {
			readRef.current();
			setOpenChannelId(null);
		};
	}, [id, setOpenChannelId, socket]);

	// The list is flex-col-reverse, so scrollTop 0 is the newest message.
	// Keep following new messages while the viewer is at the bottom.
	const newest = feed.messages?.[0]?.id;
	useEffect(() => {
		if (atEnd.current && scroller.current) scroller.current.scrollTop = 0;
	}, [newest]);

	const pinChange = (messageId: string, pinned: boolean) => feed.setPinned(messageId, pinned);
	const actions = {
		...feed.actions(),
		onReply: (m: ChannelMessage) => {
			setReplyTo(m);
			composer.current?.focus();
		},
		onThread: (messageId: string) => setThreadId(messageId)
	};

	const members = (channel?.users ?? []).filter((u) => u.id !== me?.id);
	const thread = channel && threadId && <ThreadPanel key={threadId} channel={channel} threadId={threadId} onClose={() => setThreadId(null)} onPinChange={pinChange} />;

	return (
		<div
			className="flex h-full w-full"
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes('Files')) e.preventDefault();
			}}
			onDrop={(e) => {
				if (!e.dataTransfer.files.length || !channel?.write_access) return;
				e.preventDefault();
				composer.current?.addFiles(Array.from(e.dataTransfer.files));
			}}
		>
			<div className="relative flex h-full min-w-0 flex-1 flex-col">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					{channel && (
						<>
							{channel.type === 'dm' ? (
								members.length ? (
									<div className="relative flex">
										{members.slice(0, 2).map((u, i) => (
											<img key={u.id} src={`${WEBUI_API_BASE_URL}/users/${u.id}/profile/image`} alt={u.name} className={`border-background size-6 rounded-full border-2 ${i === 1 ? '-ml-3' : ''}`} />
										))}
										{members.length === 1 && <span className={`border-background absolute right-0 bottom-0 size-2 rounded-full border ${members[0].is_active ? 'bg-green-500' : 'bg-gray-400'}`} aria-label={members[0].is_active ? 'Active' : 'Away'} />}
									</div>
								) : (
									<Users className="size-4" />
								)
							) : isPublicChannel(channel) ? (
								<Hash className="size-4" aria-label="Public channel" />
							) : (
								<Lock className="size-4" aria-label="Private channel" />
							)}
							<h1 className="line-clamp-1 flex-1 text-sm font-medium">{channelTitle(channel, me?.id)}</h1>
							<Tip content="Pinned Messages">
								<button type="button" className={headerButton} aria-label="Pinned Messages" onClick={() => setShowPinned(true)}>
									<Pin className="size-4" />
								</button>
							</Tip>
							{channel.user_count !== undefined && (
								<Tip content="Users">
									<button type="button" className={headerButton} aria-label="User Count" onClick={() => setShowInfo(true)}>
										<User className="size-4" />
										{channel.user_count}
									</button>
								</Tip>
							)}
						</>
					)}
				</header>

				{channel && feed.messages !== null ? (
					<>
						<div
							ref={scroller}
							data-testid="messages-container"
							className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto pt-6 pb-2.5"
							onScroll={(e) => {
								atEnd.current = Math.abs(e.currentTarget.scrollTop) <= 50;
							}}
						>
							<MessageList channel={channel} messages={feed.messages} top={feed.top} replyToId={replyTo?.id} onLoadMore={feed.loadMore} actions={actions} />
						</div>
						<div className="px-2.5 pt-5 pb-4">
							<MessageComposer
								ref={composer}
								channel={channel}
								disabled={!channel.write_access}
								placeholder={channel.write_access ? 'Type here...' : 'You do not have permission to send messages in this channel.'}
								typingUsers={feed.typing}
								replyTo={replyTo}
								onCancelReply={() => setReplyTo(null)}
								onTyping={() => {
									feed.emitTyping();
									readRef.current();
								}}
								onSubmit={(v) => {
									atEnd.current = true;
									void feed.submit(v, replyTo);
									setReplyTo(null);
								}}
							/>
						</div>
					</>
				) : (
					<div className="flex flex-1 items-center justify-center">
						<Spinner className="size-5" />
					</div>
				)}
			</div>

			{largeScreen ? (
				thread && <aside className="h-full w-[420px] shrink-0 border-l shadow-xl">{thread}</aside>
			) : (
				<Sheet open={Boolean(threadId)} onOpenChange={(open) => !open && setThreadId(null)}>
					<SheetContent side="right" className="w-full p-0 sm:max-w-md [&>button]:hidden">
						<SheetTitle className="sr-only">Thread</SheetTitle>
						{thread}
					</SheetContent>
				</Sheet>
			)}

			{channel && (
				<>
					<PinnedMessagesDialog open={showPinned} onOpenChange={setShowPinned} channel={channel} onPinChange={pinChange} />
					<ChannelInfoDialog open={showInfo} onOpenChange={setShowInfo} channel={channel} onUpdate={() => queryClient.invalidateQueries({ queryKey: ['channel', id] })} />
				</>
			)}
		</div>
	);
}
