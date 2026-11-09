import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Channel } from './channelModel';
import { SidebarChannels } from './SidebarChannels';

// A group channel saved as Public is listed to everyone who may use
// channels, marked as not joined, and the channel page joins it when opened
// (#331). Making one public takes sharing.public_channels, and turning a
// private one public asks first. The server's side (listing, reading, the
// join, who may post, the permission) is in
// apps/server/tests/test_channel_public_groups.py.

const { createNewChannel, updateChannelById, toast, list, me } = vi.hoisted(() => ({
	toast: { error: vi.fn(), success: vi.fn() },
	createNewChannel: vi.fn(async () => ({ id: 'new' })),
	updateChannelById: vi.fn(async () => ({ id: 'team' })),
	list: { current: [] as Channel[] },
	me: { current: { id: 'me', name: 'Me', role: 'user', permissions: {} } as Record<string, unknown> }
}));

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: me.current })
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/lib/apis/channels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	createNewChannel,
	updateChannelById
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

const permitted = (allowed: boolean) => {
	me.current = { id: 'me', name: 'Me', role: 'user', permissions: { sharing: { public_channels: allowed } } };
};

afterEach(() => {
	cleanup();
	createNewChannel.mockClear();
	updateChannelById.mockClear();
	toast.error.mockClear();
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

	it('creates a group channel as Public when that is chosen and permitted', async () => {
		list.current = [];
		permitted(true);
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

	it('offers Public only to those with sharing.public_channels', async () => {
		list.current = [];
		permitted(false);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Create Channel' }));
		await screen.findByLabelText(/Channel Name/);
		const option = screen.getByRole('option', { name: 'Public' }) as HTMLOptionElement;
		expect(option.disabled).toBe(true);
		expect(screen.getByText('Making a channel public needs a permission from an admin.')).toBeTruthy();
	});

	it('asks before turning a private channel public, and saves only once confirmed', async () => {
		list.current = [group('team', { is_private: true, is_member: true, user_id: 'me' })];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit team' }));
		fireEvent.change(await screen.findByLabelText('Visibility'), { target: { value: 'public' } });
		fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));

		expect(await screen.findByText(/read its whole history/)).toBeTruthy();
		expect(updateChannelById).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Make public' }));

		await waitFor(() => expect(updateChannelById).toHaveBeenCalled());
		expect(updateChannelById.mock.calls[0]).toEqual(['t', 'team', expect.objectContaining({ is_private: false })]);
	});

	it('does not ask again when a public channel stays public', async () => {
		list.current = [group('lobby', { is_private: false, is_member: true, user_id: 'me' })];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit lobby' }));
		await screen.findByLabelText('Visibility');
		fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
		await waitFor(() => expect(updateChannelById).toHaveBeenCalled());
		expect(screen.queryByText(/read its whole history/)).toBeNull();
	});

	it('cancelling the confirmation keeps the channel private and saves nothing', async () => {
		list.current = [group('team', { is_private: true, is_member: true, user_id: 'me' })];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit team' }));
		fireEvent.change(await screen.findByLabelText('Visibility'), { target: { value: 'public' } });
		fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));

		await screen.findByText(/read its whole history/);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByText(/read its whole history/)).toBeNull());
		expect(updateChannelById).not.toHaveBeenCalled();
	});

	it('refuses a direct message with nobody in it', async () => {
		list.current = [];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Create Channel' }));
		fireEvent.change(await screen.findByLabelText('Channel Type'), { target: { value: 'dm' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Please select at least one user for Direct Message channel.')
		);
		expect(createNewChannel).not.toHaveBeenCalled();
	});

	it('warns that saving makes a public channel private for someone without the permission', async () => {
		list.current = [group('lobby', { is_private: false, is_member: true, user_id: 'me' })];
		permitted(false);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit lobby' }));
		await screen.findByLabelText('Visibility');
		expect(screen.getByText('You may not keep this channel public: saving makes it private.')).toBeTruthy();
	});
});
