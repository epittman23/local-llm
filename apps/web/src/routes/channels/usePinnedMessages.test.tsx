import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hideConversation } from './useChannels';
import { putBack, usePinnedMessages } from './usePinnedMessages';

// #252: the pinned dialog's unpin and the sidebar's hide were shown at once and
// never put back when the server refused them.

const { api, toast } = vi.hoisted(() => ({
	api: {
		getChannelPinnedMessages: vi.fn(),
		pinMessage: vi.fn(),
		getChannels: vi.fn(),
		updateChannelMemberActiveStatusById: vi.fn()
	},
	toast: { error: vi.fn() }
}));
vi.mock('@/lib/apis/channels', () => api);
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));
vi.mock('sonner', () => ({ toast }));

const msg = (id: string) => ({ id, channel_id: 'c1', user_id: 'me', content: id, created_at: 1, updated_at: 1 });

beforeEach(() => {
	vi.resetAllMocks();
});

describe('usePinnedMessages', () => {
	it('a first page that fails is a failure, not an empty list, and a retry loads it', async () => {
		api.getChannelPinnedMessages.mockRejectedValueOnce('500 Server error').mockResolvedValueOnce([msg('p1')]);
		const { result } = renderHook(() => usePinnedMessages('c1', true, vi.fn()));
		await waitFor(() => expect(result.current.failed).toBe(true));
		expect(result.current.messages).toBeNull();

		await act(() => result.current.load(true));
		expect(result.current.failed).toBe(false);
		expect(result.current.messages?.map((m) => m.id)).toEqual(['p1']);
	});

	it('a refused unpin puts the message back in its place and says it is still pinned', async () => {
		api.getChannelPinnedMessages.mockResolvedValue([msg('p1'), msg('p2'), msg('p3')]);
		api.pinMessage.mockRejectedValue('403 Forbidden');
		const onPinChange = vi.fn();
		const { result } = renderHook(() => usePinnedMessages('c1', true, onPinChange));
		await waitFor(() => expect(result.current.messages).toHaveLength(3));

		await act(() => result.current.unpin(msg('p2') as never));
		expect(toast.error).toHaveBeenCalledWith('403 Forbidden');
		expect(result.current.messages?.map((m) => m.id)).toEqual(['p1', 'p2', 'p3']);
		expect(onPinChange.mock.calls).toEqual([
			['p2', false],
			['p2', true]
		]);
	});

	it('an unpin the server accepts stays', async () => {
		api.getChannelPinnedMessages.mockResolvedValue([msg('p1')]);
		api.pinMessage.mockResolvedValue({});
		const { result } = renderHook(() => usePinnedMessages('c1', true, vi.fn()));
		await waitFor(() => expect(result.current.messages).toHaveLength(1));

		await act(() => result.current.unpin(msg('p1') as never));
		expect(result.current.messages).toEqual([]);
	});
});

describe('putBack', () => {
	it('puts a message back once, at its index or at the end', () => {
		const list = [msg('a'), msg('c')] as never[];
		expect(putBack(list, msg('b') as never, 1)?.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(putBack(list, msg('b') as never, -1)?.map((m) => m.id)).toEqual(['a', 'c', 'b']);
		expect(putBack(list, msg('a') as never, 0)).toBe(list);
		expect(putBack(null, msg('a') as never, 0)).toBeNull();
	});
});

describe('hideConversation', () => {
	const setup = () => {
		const client = new QueryClient();
		client.setQueryData(['channels'], [{ id: 'd1' }, { id: 'c1' }]);
		const invalidate = vi.spyOn(client, 'invalidateQueries');
		return { client, invalidate };
	};

	it('a refused hide fetches the list back', async () => {
		api.updateChannelMemberActiveStatusById.mockRejectedValue('403 Forbidden');
		const { client, invalidate } = setup();
		await hideConversation(client, 't', 'd1');
		expect(toast.error).toHaveBeenCalledWith('403 Forbidden');
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['channels'] });
	});

	it('an accepted hide leaves it out', async () => {
		api.updateChannelMemberActiveStatusById.mockResolvedValue(true);
		const { client, invalidate } = setup();
		await hideConversation(client, 't', 'd1');
		expect(client.getQueryData(['channels'])).toEqual([{ id: 'c1' }]);
		expect(invalidate).not.toHaveBeenCalled();
	});
});
