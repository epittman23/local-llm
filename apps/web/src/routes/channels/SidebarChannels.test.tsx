import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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

const { createNewChannel, updateChannelById, toast, list, me, enabled } = vi.hoisted(() => ({
	enabled: { current: true },
	toast: { error: vi.fn(), success: vi.fn() },
	createNewChannel: vi.fn(async () => ({ id: 'new' })),
	updateChannelById: vi.fn(async () => ({ id: 'team' })),
	list: { current: [] as Channel[] },
	me: { current: { id: 'me', name: 'Me', role: 'user', permissions: {} } as Record<string, unknown> }
}));

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: me.current })
}));
// A relative image URL would be fetched from the test server; a data: URL is not.
vi.mock('@/lib/constants', async (importOriginal) => ({
	...(await importOriginal<object>()),
	WEBUI_API_BASE_URL: 'data:,api'
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
	useChannelsEnabled: () => enabled.current,
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

function Where() {
	const location = useLocation();
	return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

const show = (onNavigate?: () => void) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<SidebarChannels onNavigate={onNavigate} />
					<Routes>
						<Route path="*" element={<Where />} />
					</Routes>
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

describe('the Channels header', () => {
	it('lines up with the Folders header of the chat list, with no inset of its own', () => {
		list.current = [];
		show();
		const toggle = screen.getByRole('button', { name: 'Channels' });
		expect(toggle).toHaveAttribute('aria-expanded');
		expect(toggle.parentElement).toHaveClass('flex', 'items-center');
		expect(toggle.parentElement).not.toHaveClass('px-2');
		expect(screen.getByRole('button', { name: 'New channel' })).toHaveClass('mr-1');
	});

	it('opens New channel on the channels page and closes the phone sheet first (#967)', () => {
		list.current = [];
		const onNavigate = vi.fn();
		show(onNavigate);
		fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
		expect(screen.getByTestId('where')).toHaveTextContent('/channels?new=1');
		expect(onNavigate).toHaveBeenCalled();
		expect(screen.getByRole('link', { name: 'All channels' })).toHaveAttribute('href', '/channels');
	});

	it('is not shown while the install has one account (S6-D1)', () => {
		list.current = [group('team', {})];
		enabled.current = false;
		show();
		expect(screen.queryByRole('button', { name: 'Channels' })).toBeNull();
		expect(screen.queryByRole('link', { name: /team/ })).toBeNull();
		enabled.current = true;
	});
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

	it('asks before turning a private channel public, and saves only once confirmed', async () => {
		list.current = [group('team', { is_private: true, is_member: true, user_id: 'me' })];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit team' }));
		fireEvent.click(await screen.findByRole('radio', { name: 'Anyone' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

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
		await screen.findByRole('radiogroup', { name: 'Who can join' });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(updateChannelById).toHaveBeenCalled());
		expect(screen.queryByText(/read its whole history/)).toBeNull();
	});

	it('cancelling the confirmation keeps the channel private and saves nothing', async () => {
		list.current = [group('team', { is_private: true, is_member: true, user_id: 'me' })];
		permitted(true);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit team' }));
		fireEvent.click(await screen.findByRole('radio', { name: 'Anyone' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

		await screen.findByText(/read its whole history/);
		fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1) as HTMLElement);
		await waitFor(() => expect(screen.queryByText(/read its whole history/)).toBeNull());
		expect(updateChannelById).not.toHaveBeenCalled();
	});

	it('warns that saving makes a public channel private for someone without the permission', async () => {
		list.current = [group('lobby', { is_private: false, is_member: true, user_id: 'me' })];
		permitted(false);
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit lobby' }));
		await screen.findByRole('radiogroup', { name: 'Who can join' });
		expect(screen.getByText('You may not keep this channel public: saving makes it private.')).toBeTruthy();
	});
});

describe('direct messages in the sidebar', () => {
	const dm = (active: boolean): Channel => ({
		id: 'dm1',
		name: 'dm1',
		type: 'dm',
		created_at: 1,
		users: [
			{ id: 'me', name: 'Me' },
			{ id: 'u2', name: 'Quinn', is_active: active }
		] as Channel['users']
	});
	const dot = () => screen.getByRole('link', { name: /dm1/ }).querySelector('span.absolute.rounded-full');

	it('marks an active partner with the success colour', () => {
		list.current = [dm(true)];
		show();
		expect(dot()?.className).toContain('bg-success');
	});

	it('marks an away partner with the muted colour', () => {
		list.current = [dm(false)];
		show();
		expect(dot()?.className).toContain('bg-foreground-muted');
	});
});
