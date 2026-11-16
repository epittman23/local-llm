import { Hash, Lock, Plus, Users } from 'lucide-react';
import { useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { RowButton } from '@/components/ui/row-button';
import { useAuthStore } from '@/lib/stores/authStore';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { NotFound } from '@/routes/NotFound';
import { routePaths } from '@/routes/routePaths';
import { ChannelFormDialog } from './ChannelDialogs';
import { type Channel, channelTitle, formatUnread, isPublicChannel } from './channelModel';
import { useChannelList, useChannelsEnabled, useCreateChannel, useMarkChannelRead } from './useChannels';

const KIND: Record<string, string> = { group: 'Group', dm: 'Direct message' };

function ChannelIcon({ channel }: { channel: Channel }) {
	if (channel.type === 'dm') return <Users aria-hidden className="size-4 shrink-0" />;
	return isPublicChannel(channel) ? (
		<Hash aria-hidden className="size-4 shrink-0" />
	) : (
		<Lock aria-hidden className="size-4 shrink-0" />
	);
}

/**
 * /channels (#971): what a channel is, every channel you are in with its
 * unread count, and New channel. `?new=1` opens the new-channel dialog, which
 * the sidebar's + links to, so on a phone the navigation sheet closes first
 * (#967). While the install has one account Channels are hidden (S6-D1), and
 * the address is not found, as any other is.
 */
export function ChannelsPage() {
	const enabled = useChannelsEnabled();
	return <FeatureGate feature="channels">{enabled ? <Channels /> : <NotFound />}</FeatureGate>;
}

function Channels() {
	const me = useAuthStore((s) => s.user);
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const channels = useChannelList();
	const create = useCreateChannel();
	const markRead = useMarkChannelRead();
	const creating = params.get('new') === '1';
	// The new channel opens once its dialog has closed, in place of the dialog's address.
	const created = useRef<string | null>(null);
	const onSubmit = async (payload: Record<string, unknown>) => {
		created.current = await create(payload);
		return created.current !== null;
	};
	const onOpenChange = (open: boolean) => {
		const id = created.current;
		created.current = null;
		if (!open && id) navigate(`${routePaths.channels}/${id}`, { replace: true });
		else setCreating(open);
	};
	const setCreating = (open: boolean) =>
		setParams(
			(p) => {
				if (open) p.set('new', '1');
				else p.delete('new');
				return p;
			},
			{ replace: !open }
		);
	const list = channels.data ?? [];
	const newChannel = (
		<Button type="button" onClick={() => setCreating(true)}>
			<Plus data-icon="inline-start" />
			New channel
		</Button>
	);

	return (
		<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
			<div className="border-b px-4 pt-4 pb-3">
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader
						title="Channels"
						description="Rooms where the people on this server write to each other, and a model answers when mentioned."
						action={newChannel}
					/>
				</div>
			</div>
			<ChannelFormDialog open={creating} onOpenChange={onOpenChange} onSubmit={onSubmit} />
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				{channels.isError ? (
					<LoadFailed
						what="channels"
						error={channels.error}
						onRetry={() => channels.refetch()}
						retrying={channels.isFetching}
					/>
				) : channels.isLoading ? (
					<div className="flex justify-center py-16">
						<Spinner className="size-5" />
					</div>
				) : list.length === 0 ? (
					<ListEmptyState
						title="No channels yet"
						description="A channel keeps a conversation between people in one place. Mention a model with @ to have it answer."
						action={newChannel}
					/>
				) : (
					<ul className="grid min-w-0 gap-0.5" aria-label="Channels">
						{list.map((c) => {
							const unread = c.unread_count ?? 0;
							const joined = c.is_member !== false;
							return (
								<li key={c.id}>
									<RowButton
										className="flex min-w-0 items-center gap-3 px-3 py-2.5"
										onClick={() => {
											markRead(c.id);
											navigate(`${routePaths.channels}/${c.id}`);
										}}
									>
										<ChannelIcon channel={c} />
										<span className="min-w-0 flex-1 truncate font-strong">{channelTitle(c, me?.id)}</span>
										{c.type && KIND[c.type] && <Badge variant="secondary">{KIND[c.type]}</Badge>}
										{!joined && <Badge variant="secondary">Not joined</Badge>}
										{joined && unread > 0 && <Badge variant="secondary">{formatUnread(unread)} unread</Badge>}
									</RowButton>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}
