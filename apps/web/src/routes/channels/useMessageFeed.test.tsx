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
	vi.resetAllMocks();
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

	it('shows the loader, not the Retry row, while a retry is in flight', async () => {
		let resolve: (v: unknown) => void = () => {};
		api.getChannelMessages
			.mockResolvedValueOnce(page(50))
			.mockRejectedValueOnce('502 Bad Gateway')
			.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(50));
		await act(() => result.current.loadMore());
		expect(result.current.failed).toBe(true);

		let retry: Promise<void> = Promise.resolve();
		act(() => {
			retry = result.current.loadMore();
		});
		expect(result.current.failed).toBe(false);
		await act(async () => {
			resolve(page(10, 50));
			await retry;
		});
		expect(result.current.messages).toHaveLength(60);
		expect(result.current.failed).toBe(false);
	});

	it('ignores a page of older messages that fails after the channel changed', async () => {
		let reject: (e: unknown) => void = () => {};
		api.getChannelMessages
			.mockResolvedValueOnce(page(50))
			.mockReturnValueOnce(new Promise((_, r) => (reject = r)))
			.mockResolvedValueOnce(page(50, 100))
			.mockResolvedValueOnce(page(5, 150));
		const { result, rerender } = renderHook(({ id }) => useMessageFeed(id, null), { initialProps: { id: 'c1' } });
		await waitFor(() => expect(result.current.messages).toHaveLength(50));
		let stale: Promise<void> = Promise.resolve();
		act(() => {
			stale = result.current.loadMore();
		});

		rerender({ id: 'c2' });
		await waitFor(() => expect(result.current.messages?.[0]?.id).toBe('m100'));
		await act(async () => {
			reject('502 Bad Gateway');
			await stale;
		});
		expect(toast.error).not.toHaveBeenCalled();
		expect(result.current.failed).toBe(false);
		expect(result.current.messages).toHaveLength(50);

		// The stale page does not hold the new channel's loader either.
		await act(() => result.current.loadMore());
		expect(api.getChannelMessages).toHaveBeenLastCalledWith('t', 'c2', 50, 50);
		expect(result.current.messages).toHaveLength(55);
	});

	it('ignores a page of older messages that fails after unmount', async () => {
		let reject: (e: unknown) => void = () => {};
		api.getChannelMessages.mockResolvedValueOnce(page(50)).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
		const { result, unmount } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(50));
		let stale: Promise<void> = Promise.resolve();
		act(() => {
			stale = result.current.loadMore();
		});
		unmount();
		reject('502 Bad Gateway');
		await stale;
		expect(toast.error).not.toHaveBeenCalled();
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
