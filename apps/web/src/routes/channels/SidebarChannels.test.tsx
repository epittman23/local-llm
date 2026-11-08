import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Channel } from './channelModel';
import { SidebarChannels } from './SidebarChannels';

// A group channel saved as Public is listed to everyone who may use
// channels, marked as not joined, and opening it joins it (#331). The
// server's side (listing, reading, the join, who may post) is in
// apps/server/tests/test_channel_public_groups.py.

const { createNewChannel, list } = vi.hoisted(() => ({
	createNewChannel: vi.fn(async () => ({ id: 'new' })),
	list: { current: [] as Channel[] }
}));

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/apis/channels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	createNewChannel
}));
vi.mock('./useChannels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	useChannelsEnabled: () => true,
	useChannelList: () => ({ data: list.current }),
	useMarkChannelRead: () => () => {}
}));

const group = (id: string, extra: Partial<Channel>): Channel => ({
	id,
	name: id,
	type: 'group',
	created_at: 1,
	user_id: 'owner',
	...extra
});

const show = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<SidebarChannels />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

afterEach(() => {
	cleanup();
	createNewChannel.mockClear();
});

describe('public group channels in the sidebar', () => {
	it('marks a public group the viewer has not joined, and links to it to join', () => {
		list.current = [
			group('lobby', { is_private: false, is_member: false, unread_count: 4 }),
			group('team', { is_private: true, is_member: true, unread_count: 2 })
		];
		show();

		const lobby = screen.getByRole('link', { name: /lobby/ });
		expect(lobby.getAttribute('href')).toBe('/channels/lobby');
		expect(lobby.textContent).toContain('Join');
		expect(lobby.textContent).not.toContain('4');

		const team = screen.getByRole('link', { name: /team/ });
		expect(team.textContent).not.toContain('Join');
		expect(team.textContent).toContain('2');
	});

	it('shows no mark once the viewer is a member', () => {
		list.current = [group('lobby', { is_private: false, is_member: true })];
		show();
		expect(screen.getByRole('link', { name: /lobby/ }).textContent).not.toContain('Join');
	});

	it('creates a group channel as Public when that is chosen', async () => {
		list.current = [];
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Create Channel' }));

		fireEvent.change(await screen.findByLabelText(/Channel Name/), { target: { value: 'lobby' } });
		const visibility = screen.getByLabelText('Visibility');
		expect((visibility as HTMLSelectElement).value).toBe('private');
		fireEvent.change(visibility, { target: { value: 'public' } });
		expect(screen.getByText('Visible to all users')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

		await waitFor(() => expect(createNewChannel).toHaveBeenCalled());
		expect(createNewChannel.mock.calls[0]).toEqual([
			't',
			expect.objectContaining({ type: 'group', name: 'lobby', is_private: false })
		]);
	});
});
