import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChannelPage } from './ChannelPage';
import type { Channel } from './channelModel';

// Opening a public group channel the viewer has not joined joins it, once, by
// a POST; a member, a private channel or a DM is never joined (#331).

const { getChannelById, joinChannelById, toast } = vi.hoisted(() => ({
	getChannelById: vi.fn(),
	joinChannelById: vi.fn(),
	toast: { error: vi.fn() }
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis/channels', () => ({ getChannelById, joinChannelById }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('./useMessageFeed', () => ({
	useMessageFeed: () => ({ messages: [], actions: () => ({}), setPinned: () => {} })
}));
vi.mock('./MessageList', () => ({ MessageList: () => null }));
vi.mock('./MessageComposer', () => ({ MessageComposer: () => null }));
vi.mock('./ThreadPanel', () => ({ ThreadPanel: () => null }));
vi.mock('./ChannelDialogs', () => ({ ChannelInfoDialog: () => null, PinnedMessagesDialog: () => null }));

const channel = (extra: Partial<Channel>): Channel => ({
	id: 'c1',
	name: 'lobby',
	type: 'group',
	created_at: 1,
	user_id: 'owner',
	...extra
});

const open = (c: Channel) => {
	getChannelById.mockResolvedValue(c);
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/channels/c1']}>
					<Routes>
						<Route path="/channels/:id" element={<ChannelPage />} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
};

beforeEach(() => {
	vi.resetAllMocks();
	joinChannelById.mockResolvedValue({});
});
afterEach(cleanup);

describe('opening a channel', () => {
	it('joins a public group channel the viewer is not a member of, once, then reloads it', async () => {
		open(channel({ is_private: false, is_member: false }));
		await waitFor(() => expect(joinChannelById).toHaveBeenCalledTimes(1));
		expect(joinChannelById).toHaveBeenCalledWith('t', 'c1');
		// The reload after the join fetches the channel again.
		await waitFor(() => expect(getChannelById.mock.calls.length).toBeGreaterThan(1));
		expect(joinChannelById).toHaveBeenCalledTimes(1);
	});

	it('does not join for a member, a private channel or a DM', async () => {
		for (const c of [
			channel({ is_private: false, is_member: true }),
			channel({ is_private: true, is_member: false }),
			channel({ type: 'dm', is_private: null, is_member: false })
		]) {
			const view = open(c);
			await screen.findByText(c.type === 'dm' ? /./ : '#lobby', undefined, { timeout: 1000 }).catch(() => {});
			await waitFor(() => expect(getChannelById).toHaveBeenCalled());
			view.unmount();
			getChannelById.mockClear();
		}
		expect(joinChannelById).not.toHaveBeenCalled();
	});

	it('says so when the join fails', async () => {
		joinChannelById.mockRejectedValue('403 Forbidden');
		open(channel({ is_private: false, is_member: false }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('403 Forbidden'));
	});
});
