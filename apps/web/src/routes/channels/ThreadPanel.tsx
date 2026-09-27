import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import type { Channel, ChannelMessage } from './channelModel';
import { type ComposerHandle, MessageComposer } from './MessageComposer';
import { MessageList } from './MessageList';
import { useMessageFeed } from './useMessageFeed';

/**
 * Ports channel/Thread.svelte: the replies to one message, with its own
 * composer. It closes itself if the root message is deleted.
 */
export function ThreadPanel({ channel, threadId, onClose, onPinChange }: { channel: Channel; threadId: string; onClose: () => void; onPinChange: (id: string, pinned: boolean) => void }) {
	const feed = useMessageFeed(channel.id, threadId, { onRootDeleted: onClose });
	const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
	const composer = useRef<ComposerHandle>(null);
	const actions = {
		...feed.actions(onPinChange),
		onReply: (m: ChannelMessage) => {
			setReplyTo(m);
			composer.current?.focus();
		}
	};

	return (
		<div className="bg-muted/30 flex h-full w-full flex-col" aria-label="Thread">
			<div className="flex items-center justify-between px-3.5 py-3">
				<h2 className="text-lg">Thread</h2>
				<button type="button" aria-label="Close thread" className="text-muted-foreground hover:text-foreground p-2" onClick={onClose}>
					<X className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pt-7">
				{feed.messages === null ? (
					<div className="flex justify-center pt-5 pb-10">
						<Spinner />
					</div>
				) : (
					<MessageList channel={channel} messages={feed.messages} top={feed.top} thread replyToId={replyTo?.id} onLoadMore={feed.loadMore} actions={actions} />
				)}
			</div>
			<div className="px-2.5 pt-5 pb-4">
				<MessageComposer
					ref={composer}
					channel={channel}
					disabled={!channel.write_access}
					placeholder={channel.write_access ? 'Reply to thread...' : 'You do not have permission to send messages in this thread.'}
					typingUsers={feed.typing}
					replyTo={replyTo}
					onCancelReply={() => setReplyTo(null)}
					onTyping={feed.emitTyping}
					onSubmit={(v) => {
						void feed.submit(v, replyTo);
						setReplyTo(null);
					}}
				/>
			</div>
		</div>
	);
}
