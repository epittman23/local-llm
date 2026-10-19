import { act, renderHook, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));

import { sendMessage } from '@/lib/apis/channels';
import { useMessageFeed } from '@/routes/channels/useMessageFeed';

afterEach(() => vi.unstubAllGlobals());

describe('send on a network failure', () => {
	it('the real API helper resolves null instead of throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
		const res = await sendMessage('t', 'c1', { content: 'hi' } as never);
		console.log('sendMessage on network failure resolved to:', res);
		expect(res).toBeNull();
	});

	it('so the optimistic copy is dropped and nothing reports the failure', async () => {
		const fetchMock = vi
			.fn()
			// first page
			.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
			// the send
			.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHook(() => useMessageFeed('c1', null));
		await waitFor(() => expect(result.current.messages).toEqual([]));
		let shownWhilePending = 0;
		let res: unknown = 'unset';
		await act(async () => {
			const p = result.current.submit({ content: 'my important message', data: { files: [] } }, null);
			shownWhilePending = result.current.messages?.length ?? -1;
			res = await p;
		});
		console.log(
			'pending copy shown:',
			shownWhilePending,
			'| submit resolved to:',
			res,
			'| messages after:',
			JSON.stringify(result.current.messages)
		);
		expect(res).toBeNull();
		expect(result.current.messages).toEqual([]);
	});
});
