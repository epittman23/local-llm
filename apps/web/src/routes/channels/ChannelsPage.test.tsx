import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChannelsPage } from './ChannelsPage';
import type { Channel } from './channelModel';

// /channels (#971), the new-channel dialog it opens (#967, #1109, S6-D2), and
// Channels hidden while the install has one account (S6-D1).

const { createNewChannel, list, me, enabled } = vi.hoisted(() => ({
	createNewChannel: vi.fn(async () => ({ id: 'new' })),
	list: { current: [] as Channel[] },
	me: { current: { id: 'me', name: 'Me', role: 'user', permissions: {} } as Record<string, unknown> },
	enabled: { current: true as boolean | null }
}));

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: me.current })
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/apis/channels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	createNewChannel
}));
vi.mock('./useChannels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	useChannelsAccess: () => (enabled.current === null ? 'unknown' : enabled.current ? 'shown' : 'hidden'),
	useChannelList: () => ({ data: list.current }),
	useMarkChannelRead: () => () => {}
}));

const show = (path = '/channels') =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route path="/channels" element={<ChannelsPage />} />
						<Route path="/channels/:id" element={<p>channel page</p>} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

const permitted = (allowed: boolean, role = 'user') => {
	me.current = { id: 'me', name: 'Me', role, permissions: { sharing: { public_channels: allowed } } };
};

afterEach(() => {
	createNewChannel.mockClear();
	enabled.current = true;
	list.current = [];
	permitted(false);
});

describe('the channels page (#971)', () => {
	it('says what a channel is, and offers the first one', () => {
		show();
		expect(screen.getByRole('heading', { level: 1, name: 'Channels' })).toBeInTheDocument();
		expect(screen.getByText('No channels yet')).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'New channel' })).toHaveLength(2);
	});

	it('lists every channel with its kind and unread count, and opens one', async () => {
		list.current = [
			{ id: 'a', name: 'Reading group', type: 'group', is_private: true, unread_count: 3, created_at: 1 },
			{ id: 'b', name: 'Lobby', type: 'group', is_private: false, is_member: false, created_at: 1 }
		];
		show();
		const [reading, lobby] = within(screen.getByRole('list', { name: 'Channels' })).getAllByRole('button');
		expect(reading).toHaveTextContent('Reading group');
		expect(reading).toHaveTextContent('3 unread');
		expect(lobby).toHaveTextContent('Not joined');
		fireEvent.click(reading);
		expect(await screen.findByText('channel page')).toBeInTheDocument();
	});

	it('waits while the account count loads, rather than saying it is not found (STA-2)', () => {
		enabled.current = null;
		show();
		expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
		expect(screen.queryByRole('heading', { name: 'Channels' })).toBeNull();
	});

	it('is not found while the install has one account (S6-D1)', () => {
		enabled.current = false;
		show();
		expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
	});
});

describe('the new-channel dialog', () => {
	it('opens from ?new=1, titled, and keeps a name as typed (S6-D2)', async () => {
		permitted(true);
		show('/channels?new=1');
		expect(await screen.findByRole('heading', { name: 'New channel' })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Apps Regression Notes!' } });
		expect(screen.getByLabelText('Name')).toHaveValue('Apps Regression Notes!');
		fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
		await waitFor(() => expect(createNewChannel).toHaveBeenCalled());
		expect(createNewChannel.mock.calls[0]).toEqual(['t', expect.objectContaining({ name: 'Apps Regression Notes!' })]);
		expect(await screen.findByText('channel page')).toBeInTheDocument();
	});

	it('marks an empty name under the field, with no browser bubble (#1109)', async () => {
		show('/channels?new=1');
		const name = await screen.findByLabelText('Name');
		expect(name.closest('form')).toHaveAttribute('novalidate');
		fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
		expect(screen.getByText('Enter a name for the channel.')).toBeInTheDocument();
		expect(name).toHaveAttribute('aria-invalid', 'true');
		expect(createNewChannel).not.toHaveBeenCalled();
	});

	it('creates a group channel as Public when that is chosen and permitted', async () => {
		permitted(true);
		show('/channels?new=1');
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'lobby' } });
		expect(screen.getByRole('radio', { name: 'Invited people' })).toHaveAttribute('aria-checked', 'true');
		fireEvent.click(screen.getByRole('radio', { name: 'Anyone' }));
		expect(screen.getByText('Anyone who may use channels can find and join it.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
		await waitFor(() => expect(createNewChannel).toHaveBeenCalled());
		expect(createNewChannel.mock.calls[0]).toEqual([
			't',
			expect.objectContaining({ type: 'group', name: 'lobby', is_private: false })
		]);
	});

	it('offers Public only to those with sharing.public_channels', async () => {
		permitted(false);
		show('/channels?new=1');
		await screen.findByLabelText('Name');
		expect(screen.getByRole('radio', { name: 'Anyone' })).toBeDisabled();
		expect(screen.getByText('Making a channel public needs the Public channels permission.')).toBeTruthy();
	});

	it('refuses a direct message with nobody in it, under the members', async () => {
		permitted(true, 'admin');
		show('/channels?new=1');
		fireEvent.click(await screen.findByRole('radio', { name: 'Direct message' }));
		fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
		expect(await screen.findByText('Choose at least one person to message.')).toBeInTheDocument();
		expect(createNewChannel).not.toHaveBeenCalled();
	});
});
