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

// A relative image URL would be fetched from the test server; a data: URL is not.
// Channels show with more than one account (S6-D1).
const accounts = vi.hoisted(() => ({ single: false, pending: false }));
vi.mock('@/routes/workspace/workspaceAccess', () => ({ useSingleUser: () => accounts.single }));
vi.mock('./useChannels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	useChannelsAccess: () => (accounts.pending ? 'unknown' : accounts.single ? 'hidden' : 'shown')
}));
vi.mock('@/lib/constants', async (importOriginal) => ({
	...(await importOriginal<object>()),
	WEBUI_API_BASE_URL: 'data:,api'
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

describe('a direct message header', () => {
	const dm = (active: boolean) =>
		channel({
			type: 'dm',
			is_private: null,
			users: [
				{ id: 'me', name: 'Me' },
				{ id: 'u2', name: 'Quinn', is_active: active }
			] as Channel['users']
		});

	it('shows a green presence dot for an active partner', async () => {
		open(dm(true));
		const dot = await screen.findByLabelText('Active');
		expect(dot.className).toContain('bg-success');
	});

	it('shows a muted presence dot for an away partner', async () => {
		open(dm(false));
		const dot = await screen.findByLabelText('Away');
		expect(dot.className).toContain('bg-foreground-muted');
	});
});

describe('the channel header (LAY-5, #1040)', () => {
	it('names the channel in its h1, with what it is, and names its buttons', async () => {
		accounts.single = false;
		open(channel({ description: 'Notes on regressions', user_count: 3 }));
		expect(await screen.findByRole('heading', { level: 1, name: 'lobby' })).toBeInTheDocument();
		expect(screen.getByText('Notes on regressions')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Pinned messages' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Members, 3' })).toBeInTheDocument();
	});

	it('says what a channel is when it has no description', async () => {
		open(channel({ is_private: true }));
		expect(await screen.findByText('A private group.')).toBeInTheDocument();
	});
});

describe('a channel that is not there (NAV-3, S6-D1)', () => {
	it('says so in place when it is gone', async () => {
		getChannelById.mockRejectedValue("We could not find what you're looking for :/");
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<MemoryRouter initialEntries={['/channels/c1']}>
						<Routes>
							<Route path="/channels/:id" element={<ChannelPage />} />
						</Routes>
					</MemoryRouter>
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByRole('heading', { name: 'This channel no longer exists' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to channels' })).toHaveAttribute('href', '/channels');
	});

	it('is not found while the install has one account', () => {
		accounts.single = true;
		open(channel({}));
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
		expect(getChannelById).not.toHaveBeenCalled();
		accounts.single = false;
	});
});

describe('while the account count loads (STA-2)', () => {
	it('waits, rather than saying the channel is not found', () => {
		accounts.pending = true;
		open(channel({}));
		expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
		expect(getChannelById).not.toHaveBeenCalled();
		accounts.pending = false;
	});
});
