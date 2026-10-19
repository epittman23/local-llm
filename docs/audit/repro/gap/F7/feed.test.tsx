import { act, renderHook, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	getChannelMessages: vi.fn(),
	getChannelThreadMessages: vi.fn(),
	sendMessage: vi.fn(),
	updateMessage: vi.fn(),
	deleteMessage: vi.fn(),
	pinMessage: vi.fn(),
	addReaction: vi.fn(),
	removeReaction: vi.fn()
}));
vi.mock('@/lib/apis/channels', () => api);
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));

import { toast } from '../../../../../apps/web/node_modules/sonner';
const toastError = vi.spyOn(toast, 'error').mockImplementation(() => 0 as never);
import { useMessageFeed } from '@/routes/channels/useMessageFeed';

const msg = (id: string, extra = {}) => ({
	id,
	channel_id: 'c1',
	user_id: 'me',
	user: { id: 'me', name: 'Me' },
	content: `text ${id}`,
	reactions: [] as never[],
	created_at: 1,
	updated_at: 1,
	...extra
});

beforeEach(() => {
	Object.values(api).forEach((f) => f.mockReset());
	toastError.mockReset();
});

describe('useMessageFeed', () => {
	it('a failed page of older messages marks the start of the channel as reached, silently', async () => {
		const first = Array.from({ length: 50 }, (_, i) => msg(`m${i}`));
		api.getChannelMessages.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('502 Bad Gateway'));
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(50));
		expect(result.current.top).toBe(false);
		await act(async () => {
			await result.current.loadMore();
		});
		console.log('after failed loadMore: top =', result.current.top, 'toasts =', toastError.mock.calls.length);
		expect(result.current.top).toBe(true);

	});

	it('a failed edit / reaction / pin / delete keeps the optimistic change', async () => {
		api.getChannelMessages.mockResolvedValueOnce([msg('a'), msg('b'), msg('c'), msg('d')]);
		const fail = () => Promise.reject(new Error('403 Forbidden'));
		api.updateMessage.mockImplementation(fail);
		api.addReaction.mockImplementation(fail);
		api.pinMessage.mockImplementation(fail);
		api.deleteMessage.mockImplementation(fail);
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(4));
		const [a, b, c, d] = result.current.messages!;
		await act(async () => {
			const actions = result.current.actions();
			actions.onEdit!(a, 'edited text');
			actions.onReaction!(b, 'tada');
			actions.onPin!(c);
			actions.onDelete!(d);
			await new Promise((r) => setTimeout(r, 10));
		});
		const ms = result.current.messages!;
		console.log(
			JSON.stringify({
				toasts: toastError.mock.calls.map((c) => String(c[0])),
				a: ms.find((m) => m.id === 'a')?.content,
				bReactions: ms.find((m) => m.id === 'b')?.reactions,
				cPinned: ms.find((m) => m.id === 'c')?.is_pinned,
				dPresent: ms.some((m) => m.id === 'd')
			})
		);
		expect(api.updateMessage).toHaveBeenCalledTimes(1);
		expect(ms.find((m) => m.id === 'a')?.content).toBe('edited text');
		expect(ms.find((m) => m.id === 'b')?.reactions).toHaveLength(1);
		expect(ms.find((m) => m.id === 'c')?.is_pinned).toBe(true);
		expect(ms.some((m) => m.id === 'd')).toBe(false);
	});

	it('a failed send removes the optimistic copy (channel)', async () => {
		api.getChannelMessages.mockResolvedValueOnce([msg('a')]);
		api.sendMessage.mockRejectedValueOnce(new Error('400'));
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		await act(async () => {
			await result.current.submit({ content: 'hello', data: { files: [] } }, null);
		});
		expect(result.current.messages!.map((m) => m.id)).toEqual(['a']);
	});
});
