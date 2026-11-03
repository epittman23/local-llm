import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageFeed } from './useMessageFeed';

// #252: an optimistic edit, pin, reaction or delete that the server refuses is
// put back as it was, instead of staying on screen as if it had been saved.

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

const msg = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	channel_id: 'c1',
	user_id: 'me',
	content: `text ${id}`,
	created_at: 1,
	updated_at: 1,
	is_pinned: false,
	pinned_by: null,
	pinned_at: null,
	reactions: [],
	...over
});
const MESSAGES = [msg('m1'), msg('m2'), msg('m3')];

beforeEach(() => {
	vi.resetAllMocks();
	api.getChannelMessages.mockResolvedValue(MESSAGES.map((m) => ({ ...m })));
	api.getChannelThreadMessages.mockResolvedValue([msg('r1'), msg('root')]);
	for (const call of ['updateMessage', 'deleteMessage', 'pinMessage', 'addReaction', 'removeReaction'] as const)
		api[call].mockRejectedValue('403 Forbidden');
});

const feed = async (opts = {}) => {
	const hook = renderHook(() => useMessageFeed('c1', null, opts));
	await waitFor(() => expect(hook.result.current.messages).toHaveLength(3));
	return hook;
};
const byId = (messages: unknown, id: string) => (messages as { id: string }[]).find((m) => m.id === id) as never;

describe('a refused change is rolled back (#252)', () => {
	it('an edit goes back to the saved text', async () => {
		const { result } = await feed();
		await act(async () => result.current.actions().onEdit(byId(result.current.messages, 'm2'), 'new text'));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('403 Forbidden'));
		expect(byId(result.current.messages, 'm2')).toMatchObject({ content: 'text m2' });
	});

	it('a pin is undone, and whoever was told of it is told again', async () => {
		const onPinChange = vi.fn();
		const { result } = await feed();
		await act(async () => result.current.actions(onPinChange).onPin(byId(result.current.messages, 'm2')));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(byId(result.current.messages, 'm2')).toMatchObject({ is_pinned: false, pinned_by: null, pinned_at: null });
		expect(onPinChange.mock.calls).toEqual([
			['m2', true],
			['m2', false]
		]);
	});

	it('a reaction is taken back off', async () => {
		const { result } = await feed();
		await act(async () => result.current.actions().onReaction(byId(result.current.messages, 'm2'), 'thumbsup'));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(byId(result.current.messages, 'm2')).toMatchObject({ reactions: [] });
	});

	it('a deleted message comes back in its place, and nothing is told it was deleted', async () => {
		const onMessageDeleted = vi.fn();
		const { result } = await feed({ onMessageDeleted });
		await act(async () => result.current.actions().onDelete(byId(result.current.messages, 'm2')));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect((result.current.messages ?? []).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
		expect(onMessageDeleted).not.toHaveBeenCalled();
	});

	it('a thread stays open when deleting its root fails', async () => {
		const onRootDeleted = vi.fn();
		const { result } = renderHook(() => useMessageFeed('c1', 'root', { onRootDeleted }));
		await waitFor(() => expect(result.current.messages).toHaveLength(2));
		await act(async () => result.current.actions().onDelete(byId(result.current.messages, 'root')));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(onRootDeleted).not.toHaveBeenCalled();
	});

	it('a change the server accepts stays, and a delete then tells the listeners', async () => {
		api.updateMessage.mockResolvedValue({});
		api.deleteMessage.mockResolvedValue(true);
		const onMessageDeleted = vi.fn();
		const { result } = await feed({ onMessageDeleted });
		await act(async () => result.current.actions().onEdit(byId(result.current.messages, 'm1'), 'kept'));
		await act(async () => result.current.actions().onDelete(byId(result.current.messages, 'm3')));
		await waitFor(() => expect(onMessageDeleted).toHaveBeenCalledWith('m3'));
		expect(byId(result.current.messages, 'm1')).toMatchObject({ content: 'kept' });
		expect((result.current.messages ?? []).map((m) => m.id)).toEqual(['m1', 'm2']);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
