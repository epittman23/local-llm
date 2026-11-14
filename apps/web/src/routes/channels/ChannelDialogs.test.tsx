import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChannelInfoDialog, WebhooksDialog } from './ChannelDialogs';
import type { Channel } from './channelModel';

const { getChannelMembersById, removeMembersById, getChannelWebhooks } = vi.hoisted(() => ({
	getChannelMembersById: vi.fn(),
	removeMembersById: vi.fn(),
	getChannelWebhooks: vi.fn()
}));

// A relative image URL would be fetched from the test server; a data: URL is not.
vi.mock('@/lib/constants', async (importOriginal) => ({
	...(await importOriginal<object>()),
	WEBUI_API_BASE_URL: 'data:,api'
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/channels', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getChannelMembersById,
	removeMembersById,
	getChannelWebhooks
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'admin' } })
}));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket: null }) }));

const channel = (extra: Partial<Channel> = {}): Channel => ({
	id: 'c1',
	name: 'lobby',
	type: 'group',
	created_at: 1,
	user_id: 'me',
	...extra
});

const wrap = (node: React.ReactNode) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>{node}</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	vi.resetAllMocks();
});
afterEach(cleanup);

describe('the channel info dialog', () => {
	const members = [
		{ id: 'u1', name: 'Ada', email: 'ada@x.io', role: 'admin', is_active: true },
		{ id: 'u2', name: 'Bob', email: 'bob@x.io', role: 'user', is_active: false }
	];

	it('marks active members and shows each role', async () => {
		getChannelMembersById.mockResolvedValue({ users: members, total: 2 });
		wrap(<ChannelInfoDialog open onOpenChange={() => {}} channel={channel()} onUpdate={() => {}} />);
		expect(await screen.findByText('Ada')).toBeInTheDocument();
		expect(screen.getAllByLabelText('Active')).toHaveLength(1);
		expect(screen.getByText('admin')).toBeInTheDocument();
		expect(screen.getByText('user')).toBeInTheDocument();
	});

	it('lets a manager remove a member', async () => {
		getChannelMembersById.mockResolvedValue({ users: members, total: 2 });
		removeMembersById.mockResolvedValue({});
		const onUpdate = vi.fn();
		wrap(
			<ChannelInfoDialog open onOpenChange={() => {}} channel={channel({ is_manager: true })} onUpdate={onUpdate} />
		);
		fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }));
		await waitFor(() => expect(removeMembersById).toHaveBeenCalledWith('t', 'c1', { user_ids: ['u2'] }));
		await waitFor(() => expect(onUpdate).toHaveBeenCalled());
	});
});

describe('the webhooks dialog', () => {
	const pixel = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
	const hook = {
		id: 'w1',
		name: 'Deploys',
		token: 'tok',
		profile_image_url: pixel,
		created_at: 1_700_000_000_000_000_000
	};

	it('says when there are no webhooks', async () => {
		getChannelWebhooks.mockResolvedValue([]);
		wrap(<WebhooksDialog open onOpenChange={() => {}} channel={channel()} />);
		expect(await screen.findByText('No webhooks yet')).toBeInTheDocument();
	});

	it('expands a webhook to show its picture button and editable name', async () => {
		getChannelWebhooks.mockResolvedValue([hook]);
		wrap(<WebhooksDialog open onOpenChange={() => {}} channel={channel()} />);
		const row = await screen.findByRole('button', { name: /Deploys/ });
		expect(row).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('button', { name: 'Change picture' })).toBeNull();
		fireEvent.click(row);
		expect(row).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('button', { name: 'Change picture' })).toBeInTheDocument();
		expect(screen.getByLabelText('Webhook Name')).toHaveValue('Deploys');
	});

	it('opens the file chooser when Change picture is pressed', async () => {
		getChannelWebhooks.mockResolvedValue([hook]);
		wrap(<WebhooksDialog open onOpenChange={() => {}} channel={channel()} />);
		fireEvent.click(await screen.findByRole('button', { name: /Deploys/ }));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).toBeTruthy();
		const click = vi.spyOn(input, 'click').mockImplementation(() => {});
		fireEvent.click(screen.getByRole('button', { name: 'Change picture' }));
		expect(click).toHaveBeenCalledTimes(1);
	});
});
