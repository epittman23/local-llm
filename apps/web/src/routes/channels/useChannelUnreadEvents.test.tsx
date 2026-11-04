import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { isLastActiveTab } from '@/lib/utils/lastActiveTab';
import { CHANNELS_KEY, useChannelUnreadEvents } from './useChannels';

// #254: only the tab looked at last plays the sound and shows the desktop
// notification for a channel message; every tab still shows its own toast.
// #255: a thread reply is announced but not counted, as the server does not
// count it; a model's reply is not announced while it is still empty.

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const handlers = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock('@/lib/socket/SocketProvider', () => ({
	useSocket: () => ({
		socket: { on: (name: string, fn: (e: unknown) => void) => handlers.set(name, fn), off: vi.fn() }
	})
}));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: { notificationEnabled: true, notificationSound: true } })
}));
vi.mock('@/lib/utils/lastActiveTab', () => ({ startLastActiveTab: () => () => {}, isLastActiveTab: vi.fn() }));

const audio = vi.fn(function (this: { play: () => Promise<void> }) {
	this.play = () => Promise.resolve();
});
const notification = Object.assign(vi.fn(), { permission: 'granted' });

const withClient =
	(client: QueryClient) =>
	({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
const wrapper = ({ children }: { children: ReactNode }) => withClient(new QueryClient())({ children });

const message = {
	channel_id: 'c1',
	channel: { id: 'c1', name: 'general', type: 'group' },
	user: { id: 'u2' },
	data: { type: 'message', data: { content: 'hello', user: { name: 'Ben' } } }
};

describe('useChannelUnreadEvents (#254, #255)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 't', user: { id: 'u1', name: 'Ann', role: 'admin' } } as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', features: { enable_channels: true } } } as never);
		vi.stubGlobal('Audio', audio);
		vi.stubGlobal('Notification', notification);
		vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		handlers.clear();
	});

	it('the tab looked at last toasts, plays the sound and shows the notification', () => {
		vi.mocked(isLastActiveTab).mockReturnValue(true);
		renderHook(() => useChannelUnreadEvents(), { wrapper });
		handlers.get('events:channel')?.(message);
		expect(toast).toHaveBeenCalledWith('Ben (#general)', expect.anything());
		expect(audio).toHaveBeenCalledTimes(1);
		expect(notification).toHaveBeenCalledWith('Ben (#general)', { body: 'hello' });
	});

	it('another tab only toasts', () => {
		vi.mocked(isLastActiveTab).mockReturnValue(false);
		renderHook(() => useChannelUnreadEvents(), { wrapper });
		handlers.get('events:channel')?.(message);
		expect(toast).toHaveBeenCalledWith('Ben (#general)', expect.anything());
		expect(audio).not.toHaveBeenCalled();
		expect(notification).not.toHaveBeenCalled();
	});

	it("announces a person's thread reply but does not count it (#255)", () => {
		vi.mocked(isLastActiveTab).mockReturnValue(true);
		const client = new QueryClient();
		client.setQueryData(CHANNELS_KEY, [{ id: 'c1', name: 'general', type: 'group', unread_count: 0 }]);
		renderHook(() => useChannelUnreadEvents(), { wrapper: withClient(client) });
		handlers.get('events:channel')?.({
			...message,
			data: { type: 'message', data: { ...message.data.data, parent_id: 'm1' } }
		});
		expect(toast).toHaveBeenCalledWith('Ben (#general)', expect.anything());
		expect(client.getQueryData<{ unread_count: number }[]>(CHANNELS_KEY)?.[0].unread_count).toBe(0);
	});

	it("does not announce a model's reply while it is still empty (#255)", () => {
		vi.mocked(isLastActiveTab).mockReturnValue(true);
		renderHook(() => useChannelUnreadEvents(), { wrapper });
		handlers.get('events:channel')?.({
			...message,
			data: { type: 'message', data: { ...message.data.data, content: '', meta: { model_id: 'm' } } }
		});
		expect(toast).not.toHaveBeenCalled();
		expect(audio).not.toHaveBeenCalled();
		expect(notification).not.toHaveBeenCalled();
	});

	it("announces a model's reply that already has text", () => {
		vi.mocked(isLastActiveTab).mockReturnValue(true);
		renderHook(() => useChannelUnreadEvents(), { wrapper });
		handlers.get('events:channel')?.({
			...message,
			data: { type: 'message', data: { ...message.data.data, content: 'done', meta: { model_id: 'm' } } }
		});
		expect(toast).toHaveBeenCalledOnce();
	});
});
