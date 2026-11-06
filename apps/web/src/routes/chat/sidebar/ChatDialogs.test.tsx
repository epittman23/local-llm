import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DROPPED_GRANTS_WARNING } from '@/lib/access/accessGrants';
import {
	deleteSharedChatById,
	getChatAccessGrants,
	getChatById,
	shareChatById,
	updateChatAccessGrants
} from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { ShareChatDialog } from './ChatDialogs';

const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	toastWarning: vi.fn()
}));
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() })
}));

vi.mock('@/lib/apis/chats', () => ({
	getChatById: vi.fn(),
	shareChatById: vi.fn(),
	deleteSharedChatById: vi.fn(),
	getChatAccessGrants: vi.fn(),
	updateChatAccessGrants: vi.fn(),
	getChatListBySearchText: vi.fn(async () => [])
}));
vi.mock('@/lib/apis/groups', () => ({ getGroups: vi.fn(async () => []), getGroupInfoById: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUserInfoById: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn(async () => true)
}));

const PUBLIC_READ = { principal_type: 'user', principal_id: '*', permission: 'read' };

const open = (onOpenChange = vi.fn()) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ShareChatDialog open onOpenChange={onOpenChange} chatId="c1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return onOpenChange;
};

const signIn = (permissions: object) =>
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { role: 'user', permissions } } as never);

beforeEach(() => {
	vi.clearAllMocks();
	signIn({ sharing: { public_chats: true } });
});

describe('ShareChatDialog: who can open the link (#334)', () => {
	it("shows a shared chat's stored access", async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([PUBLIC_READ] as never);
		open();

		expect(await screen.findByLabelText('Visibility')).toHaveValue('public');
		expect(getChatAccessGrants).toHaveBeenCalledWith('t', 'c1');
	});

	it('saves a change, then shows what was stored', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants)
			.mockResolvedValueOnce([])
			.mockResolvedValue([PUBLIC_READ] as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		fireEvent.change(await screen.findByLabelText('Visibility'), { target: { value: 'public' } });

		await waitFor(() => expect(updateChatAccessGrants).toHaveBeenCalledWith('t', 'c1', [PUBLIC_READ]));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Access updated'));
		expect(screen.getByLabelText('Visibility')).toHaveValue('public');
	});

	it('says so when the server keeps less than was sent', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		// Stored without the public grant, as the server stores it for a user who may not set it.
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		fireEvent.change(await screen.findByLabelText('Visibility'), { target: { value: 'public' } });

		await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(DROPPED_GRANTS_WARNING));
		await waitFor(() => expect(screen.getByLabelText('Visibility')).toHaveValue('private'));
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it('does not tell an unshared chat that anyone with the URL can view it', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		open();

		await screen.findByRole('button', { name: /Copy Link/ });
		expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
		expect(screen.queryByText(/Users with the URL will be able to view/)).not.toBeInTheDocument();
		expect(getChatAccessGrants).not.toHaveBeenCalled();
	});

	it('keeps the dialog open after a new link, to choose who can open it', async () => {
		vi.mocked(getChatById)
			.mockResolvedValueOnce({ share_id: null } as never)
			.mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		const onOpenChange = open();

		const copyLink = await screen.findByRole('button', { name: /Copy Link/ });
		await waitFor(() => expect(copyLink).toBeEnabled());
		fireEvent.click(copyLink);

		expect(await screen.findByLabelText('Visibility')).toHaveValue('private');
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Copied/));
	});

	const options = () =>
		Array.from((screen.getByLabelText('Visibility') as HTMLSelectElement).options).map((o) => o.value);

	it("offers Public and Open only as the user's sharing permissions allow", async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);

		signIn({});
		open();
		await screen.findByLabelText('Visibility');
		expect(options()).toEqual(['private']);
	});

	it('offers Public and Open to a user allowed both', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		signIn({ sharing: { public_chats: true, open_chats: true } });
		open();
		await screen.findByLabelText('Visibility');
		expect(options()).toEqual(['private', 'public', 'open']);
	});

	it('offers an admin every choice, whatever the permissions say', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		useAuthStore.setState({ status: 'authenticated', token: 't', user: { role: 'admin', permissions: {} } } as never);
		open();
		await screen.findByLabelText('Visibility');
		expect(options()).toEqual(['private', 'public', 'open']);
	});

	it('goes back to what was stored when a save fails', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(updateChatAccessGrants).mockRejectedValue('refused');
		open();

		fireEvent.change(await screen.findByLabelText('Visibility'), { target: { value: 'public' } });

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('refused'));
		await waitFor(() => expect(screen.getByLabelText('Visibility')).toHaveValue('private'));
	});

	it('sends two quick changes one after the other, and reports only the last', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		let stored: unknown[] = [];
		vi.mocked(getChatAccessGrants).mockImplementation(async () => stored as never);
		let release: () => void = () => {};
		const order: string[] = [];
		vi.mocked(updateChatAccessGrants).mockImplementation(async (_t, _id, grants) => {
			const label = (grants as unknown[]).length ? 'public' : 'private';
			order.push(`start ${label}`);
			if (label === 'public') await new Promise<void>((resolve) => (release = resolve));
			stored = grants as unknown[];
			order.push(`end ${label}`);
			return { id: 'c1' } as never;
		});
		open();
		const visibility = await screen.findByLabelText('Visibility');

		fireEvent.change(visibility, { target: { value: 'public' } });
		await waitFor(() => expect(order).toEqual(['start public']));
		fireEvent.change(visibility, { target: { value: 'private' } });
		release();

		await waitFor(() => expect(order).toEqual(['start public', 'end public', 'start private', 'end private']));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastWarning).not.toHaveBeenCalled();
		expect(screen.getByLabelText('Visibility')).toHaveValue('private');
	});

	it('keeps the panel when deleting the link fails', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([PUBLIC_READ] as never);
		vi.mocked(deleteSharedChatById).mockRejectedValue('not now');
		open();
		await screen.findByLabelText('Visibility');

		fireEvent.click(screen.getByRole('button', { name: 'Delete this link' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('not now'));
		expect(screen.getByLabelText('Visibility')).toHaveValue('public');
	});
});
