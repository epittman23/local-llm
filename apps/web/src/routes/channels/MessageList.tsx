import { useMemo } from 'react';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Spinner } from '@/components/common/Spinner';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { type Channel, type ChannelMessage, channelTitle, showsAuthor } from './channelModel';
import { ChannelMessageView, type MessageActions } from './ChannelMessageView';

/**
 * Ports channel/Messages.svelte: the messages oldest-first, a loader at the
 * top that pages back while there is more, and, once the start is reached in
 * the channel itself, the "beginning of the channel" header.
 */
export function MessageList({
	channel,
	messages,
	top,
	thread = false,
	replyToId,
	onLoadMore,
	actions
}: {
	channel: Channel;
	messages: ChannelMessage[];
	top: boolean;
	thread?: boolean;
	replyToId?: string | null;
	onLoadMore: () => void;
	actions: MessageActions;
}) {
	const me = useAuthStore((s) => s.user);
	const list = useMemo(() => messages.slice().reverse(), [messages]);
	const readOnly = !channel.write_access;

	return (
		<div>
			{!top ? (
				<InfiniteLoader onVisible={onLoadMore}>
					<div className="text-muted-foreground flex items-center justify-center gap-2 py-1 text-xs">
						<Spinner className="size-4" /> Loading...
					</div>
				</InfiniteLoader>
			) : (
				!thread && (
					<div className="px-5">
						<div className="flex flex-col gap-1.5 pt-10 pb-5">
							{channel.type === 'dm' && (
								<div className="flex">
									{(channel.users ?? [])
										.filter((u) => u.id !== me?.id)
										.slice(0, 2)
										.map((u, i) => (
											<img
												key={u.id}
												src={`${WEBUI_API_BASE_URL}/users/${u.id}/profile/image`}
												alt={u.name}
												className={`border-background size-7 rounded-full border-2 ${i === 1 ? '-ml-2.5' : ''}`}
											/>
										))}
								</div>
							)}
							<h2 className="text-2xl">{channelTitle(channel, me?.id)}</h2>
							<p className="text-muted-foreground text-sm">
								This channel was created on {dayjs(channel.created_at / 1_000_000).format('MMMM D, YYYY')}. This is the
								very beginning of the {channelTitle(channel, me?.id)} channel.
							</p>
						</div>
						{list.length > 0 && <hr className="mb-2.5" />}
					</div>
				)
			)}

			{list.map((m, i) => (
				<ChannelMessageView
					key={m.id}
					message={m}
					channelId={channel.id}
					thread={thread}
					domPrefix={thread ? 'thread-' : ''}
					showAuthor={showsAuthor(messages, messages.length - 1 - i)}
					highlighted={replyToId === m.id}
					disabled={readOnly}
					actions={actions}
				/>
			))}
			<div className="pb-6" />
		</div>
	);
}
