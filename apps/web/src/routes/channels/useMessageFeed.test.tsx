import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageFeed } from './useMessageFeed';

const { api, toast } = vi.hoisted(() => ({
	api: {
		getChannelMessages: vi.fn(),
		getChannelThreadMessages: vi.fn(),
		sendMessage: vi.fn(),
		updateMessage: vi.fn(),
		deleteMessage: vi.fn(),
		pinMessage: vi.fn(),
		addReaction: vi.fn(),
		removeReaction: vi.fn()
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
const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => msg(`m${from + i}`));

beforeEach(() => {
	vi.clearAllMocks();
});

describe('useMessageFeed', () => {
	it('reports a failed page of older messages and keeps the rest of the history loadable', async () => {
		api.getChannelMessages
			.mockResolvedValueOnce(page(50))
			.mockRejectedValueOnce('502 Bad Gateway')
			.mockResolvedValueOnce(page(10, 50));
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(50));

		await act(() => result.current.loadMore());
		expect(toast.error).toHaveBeenCalledWith('502 Bad Gateway');
		expect(result.current.top).toBe(false);
		expect(result.current.failed).toBe(true);
		expect(result.current.messages).toHaveLength(50);

		await act(() => result.current.loadMore());
		expect(api.getChannelMessages).toHaveBeenLastCalledWith('t', 'c1', 50, 50);
		expect(result.current.messages).toHaveLength(60);
		expect(result.current.top).toBe(true);
		expect(result.current.failed).toBe(false);
	});

	it('does not take a failed first page for an empty channel, and a retry loads it', async () => {
		api.getChannelThreadMessages.mockRejectedValueOnce('500 Internal Server Error').mockResolvedValueOnce(page(3));
		const { result } = renderHook(() => useMessageFeed('c1', 'root'));
		await waitFor(() => expect(result.current.messages).toEqual([]));
		expect(toast.error).toHaveBeenCalledWith('500 Internal Server Error');
		expect(result.current.top).toBe(false);
		expect(result.current.failed).toBe(true);

		await act(() => result.current.loadMore());
		expect(api.getChannelThreadMessages).toHaveBeenLastCalledWith('t', 'c1', 'root', 0, 50);
		expect(result.current.messages).toHaveLength(3);
		expect(result.current.top).toBe(true);
		expect(result.current.failed).toBe(false);
	});
});
