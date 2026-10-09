import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { create } from 'zustand';
import { canUseFeature } from '@/lib/access/features';
import { getChannels } from '@/lib/apis/channels';
import { useSocket } from '@/lib/socket/SocketProvider';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useUserSettings } from '@/lib/settings/userSettings';
import {
	type Channel,
	type ChannelEvent,
	applyUnreadEvent,
	markRead,
	mentionsToText,
	sortChannels
} from './channelModel';

// The Svelte app keeps the channel list and the open channel's id in two
// global stores (`channels`, `channelId`). Here the list is the TanStack query
// under ['channels'] (the key Automations already reads), and the open id is
// this small store: the unread listener needs it to know which channel the
// viewer is looking at.

export const CHANNELS_KEY = ['channels'] as const;

export const useOpenChannelStore = create<{
	openChannelId: string | null;
	setOpenChannelId: (id: string | null) => void;
}>((set) => ({
	openChannelId: null,
	setOpenChannelId: (openChannelId) => set({ openChannelId })
}));

export function useChannelsEnabled() {
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	return canUseFeature('channels', user, config);
}

export function useChannelList() {
	const token = useAuthStore((s) => s.token) ?? '';
	const enabled = useChannelsEnabled();
	return useQuery({
		queryKey: CHANNELS_KEY,
		enabled: enabled && Boolean(token),
		staleTime: 60_000,
		queryFn: async () => {
			const res = await getChannels(token).catch(() => null);
			return sortChannels(Array.isArray(res) ? (res as Channel[]) : []);
		}
	});
}

/** Clears a channel's unread badge in the cached list. */
export function useMarkChannelRead() {
	const queryClient = useQueryClient();
	return (channelId: string) =>
		queryClient.setQueryData<Channel[]>(CHANNELS_KEY, (list) => (list ? markRead(list, channelId) : list));
}

let soundPlaying = false;

/**
 * NotificationToast.svelte's sound: one at a time, and only once the viewer
 * has interacted with the page (browsers refuse to autoplay before that).
 */
function playNotificationSound() {
	if (soundPlaying || !navigator.userActivation?.hasBeenActive) return;
	soundPlaying = true;
	new Audio(`${import.meta.env.BASE_URL}audio/notification.mp3`)
		.play()
		.catch(() => {})
		.finally(() => {
			soundPlaying = false;
		});
}

/**
 * Ports +layout.svelte's channelEventHandler: every `events:channel` event,
 * wherever the viewer is. It keeps the sidebar's unread counts current (or
 * refetches the list when a channel appears), and announces a message from
 * someone else that the viewer is not looking at: a toast that opens the
 * channel, and a browser notification if they turned those on in Settings
 * and granted the permission. Mounted once, in AppShell.
 */
export function useChannelUnreadEvents() {
	const { socket } = useSocket();
	const enabled = useChannelsEnabled();
	const selfId = useAuthStore((s) => s.user?.id);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { settings } = useUserSettings();
	const notify = Boolean((settings as Record<string, unknown> | null)?.notificationEnabled);
	const sound = ((settings as Record<string, unknown> | null)?.notificationSound ?? true) !== false;

	useEffect(() => {
		if (!socket || !enabled) return;
		const handler = (event: ChannelEvent) => {
			const type = event.data?.type;
			if (type === 'typing') return;
			const openId = useOpenChannelStore.getState().openChannelId;
			const background = document.visibilityState !== 'visible';
			if (type === 'channel:created') {
				queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
				return;
			}
			if (event.user?.id === selfId || (event.channel_id === openId && !background)) return;

			const list = queryClient.getQueryData<Channel[]>(CHANNELS_KEY);
			const next = list ? applyUnreadEvent(list, event, openId, selfId) : null;
			if (next) queryClient.setQueryData(CHANNELS_KEY, next);
			else queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });

			if (type !== 'message') return;
			const data = event.data?.data ?? {};
			const title = `${data.user?.name ?? 'Someone'}${event.channel?.type !== 'dm' && event.channel?.name ? ` (#${event.channel.name})` : ''}`;
			const body = mentionsToText(String(data.content ?? ''));
			toast(title, {
				description: body.slice(0, 200),
				action: { label: 'Open', onClick: () => navigate(`/channels/${event.channel_id}`) }
			});
			if (sound) playNotificationSound();
			if (notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
				new Notification(title, { body });
			}
		};
		socket.on('events:channel', handler);
		return () => {
			socket.off('events:channel', handler);
		};
	}, [socket, enabled, selfId, queryClient, navigate, notify, sound]);
}
