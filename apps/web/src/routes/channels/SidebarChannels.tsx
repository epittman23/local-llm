import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Hash, Lock, Plus, Settings, User, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { createNewChannel, updateChannelById } from '@/lib/apis/channels';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useSocket } from '@/lib/socket/SocketProvider';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { ChannelFormDialog } from './ChannelDialogs';
import { type Channel, channelTitle, formatUnread, isPublicChannel } from './channelModel';
import { CHANNELS_KEY, hideConversation, useChannelList, useChannelsEnabled, useMarkChannelRead } from './useChannels';

/**
 * Ports the Channels section of layout/Sidebar.svelte with
 * Sidebar/ChannelItem.svelte and the create flow: the channel list (standard,
 * then group, then DMs, with a rule between types), unread badges, a DM's
 * members and whether its one other member is active, and per item either
 * "hide this DM" or, for its creator or an admin, the edit dialog. A public
 * group channel the viewer has not joined is listed with a "Join" mark in
 * place of the unread badge; opening it joins it (#331).
 */
export function SidebarChannels({ onNavigate }: { onNavigate?: () => void }) {
	const enabled = useChannelsEnabled();
	const token = useAuthStore((s) => s.token) ?? '';
	const { socket } = useSocket();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const channels = useChannelList();
	const [open, setOpen] = useState(true);
	const [creating, setCreating] = useState(false);

	if (!enabled) return null;
	const list = channels.data ?? [];
	const refresh = () => queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });

	const create = async (payload: Record<string, unknown>) => {
		const res = await createNewChannel(token, payload as never).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (!res) return false;
		socket?.emit('join-channels', { auth: { token } });
		await refresh();
		setOpen(true);
		navigate(`/channels/${res.id}`);
		onNavigate?.();
		return true;
	};

	return (
		<div className="mt-3">
			<div className="text-muted-foreground flex items-center px-2 text-xs font-medium">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					className="flex-1 justify-start shrink"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
					Channels
				</Button>
				<Tip content="Create Channel">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="Create Channel"
						onClick={() => setCreating(true)}
					>
						<Plus className="size-3.5" />
					</Button>
				</Tip>
			</div>
			{open && (
				<ul className="flex flex-col gap-0.5" aria-label="Channels">
					{list.map((c, i) => (
						<li key={c.id}>
							<ChannelItem channel={c} onNavigate={onNavigate} onChanged={refresh} />
							{i < list.length - 1 && (c.type ?? '') !== (list[i + 1]?.type ?? '') && <hr className="mx-2 my-1.5" />}
						</li>
					))}
				</ul>
			)}
			<ChannelFormDialog open={creating} onOpenChange={setCreating} onSubmit={create} />
		</div>
	);
}

function ChannelItem({
	channel,
	onNavigate,
	onChanged
}: {
	channel: Channel;
	onNavigate?: () => void;
	onChanged: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const me = useAuthStore((s) => s.user);
	const queryClient = useQueryClient();
	const markRead = useMarkChannelRead();
	const [editing, setEditing] = useState(false);
	const members = (channel.users ?? []).filter((u) => u.id !== me?.id);
	const unread = channel.unread_count ?? 0;
	const joined = channel.is_member !== false;
	const canEdit = me?.role === 'admin' || channel.user_id === me?.id;

	const hideDm = () => hideConversation(queryClient, token, channel.id);

	const update = async (payload: Record<string, unknown>) => {
		const { name, is_private, access_grants, group_ids, user_ids } = payload;
		const res = await updateChannelById(token, channel.id, {
			name,
			is_private,
			access_grants,
			group_ids,
			user_ids
		} as never).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) toast.success('Channel updated successfully');
		onChanged();
		queryClient.invalidateQueries({ queryKey: ['channel', channel.id] });
		return Boolean(res);
	};

	return (
		<div className="group relative">
			<NavLink
				to={`/channels/${channel.id}`}
				onClick={() => {
					markRead(channel.id);
					onNavigate?.();
				}}
				className={({ isActive }) =>
					cn(
						'flex items-center gap-2 rounded-md px-2 py-1 pr-7 text-sm',
						isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
						unread > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'
					)
				}
			>
				{channel.type === 'dm' ? (
					members.length ? (
						<span className="relative flex shrink-0">
							{members.slice(0, 2).map((u, i) => (
								<img
									key={u.id}
									src={`${WEBUI_API_BASE_URL}/users/${u.id}/profile/image`}
									alt=""
									className={cn('border-background size-5 rounded-full border', i === 1 && '-ml-2.5')}
								/>
							))}
							{members.length === 1 && (
								<span
									className={cn(
										'border-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full border',
										members[0].is_active ? 'bg-success' : 'bg-foreground-muted'
									)}
								/>
							)}
						</span>
					) : (
						<User className="size-4 shrink-0" />
					)
				) : isPublicChannel(channel) ? (
					<Hash className="size-3.5 shrink-0" />
				) : (
					<Lock className="size-3.5 shrink-0" />
				)}
				<span className="truncate">{channelTitle(channel, me?.id)}</span>
				{!joined && (
					<span
						className="ml-auto rounded border px-1 text-caption font-medium"
						title="Not joined: opening it joins it"
					>
						Join
					</span>
				)}
				{joined && unread > 0 && (
					<span
						className="bg-foreground text-background ml-auto rounded-full px-1.5 text-caption font-medium"
						title="Unread"
					>
						{formatUnread(unread)}
					</span>
				)}
			</NavLink>
			{channel.type === 'dm' ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Hide conversation"
					className="absolute top-1 right-1 hidden group-hover:inline-flex"
					onClick={() => void hideDm()}
				>
					<X className="size-3.5" />
				</Button>
			) : (
				canEdit && (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={`Edit ${channel.name}`}
						className="absolute top-1 right-1 hidden group-hover:inline-flex"
						onClick={() => setEditing(true)}
					>
						<Settings className="size-3.5" />
					</Button>
				)
			)}
			{canEdit && channel.type !== 'dm' && (
				<ChannelFormDialog
					open={editing}
					onOpenChange={setEditing}
					channel={channel}
					onSubmit={update}
					onDeleted={onChanged}
				/>
			)}
		</div>
	);
}
