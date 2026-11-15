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
import { FolderDialog, ShareChatDialog } from './ChatDialogs';

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

		await screen.findByRole('button', { name: /Copy link/ });
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

		const copyLink = await screen.findByRole('button', { name: /Copy link/ });
		await waitFor(() => expect(copyLink).toBeEnabled());
		fireEvent.click(copyLink);

		expect(await screen.findByLabelText('Visibility')).toHaveValue('private');
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toastSuccess).toHaveBeenCalledWith('Link copied');
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

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('not now'));
		expect(screen.getByLabelText('Visibility')).toHaveValue('public');
	});
});

describe('ShareChatDialog: its words (#1006)', () => {
	it('is titled Share chat, and stopping sharing is a button that removes the link and its access panel', async () => {
		vi.mocked(getChatById)
			.mockResolvedValueOnce({ share_id: 's1' } as never)
			.mockResolvedValue({ share_id: null } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([PUBLIC_READ] as never);
		vi.mocked(deleteSharedChatById).mockResolvedValue(true as never);
		open();

		expect(await screen.findByRole('dialog', { name: 'Share chat' })).toBeInTheDocument();
		await screen.findByLabelText('Visibility');
		expect(screen.getByRole('button', { name: /Update and copy link/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		await waitFor(() => expect(deleteSharedChatById).toHaveBeenCalledWith('t', 'c1'));
		await waitFor(() => expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument());
		expect(await screen.findByRole('button', { name: /^Copy link$/ })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
	});
});

describe('FolderDialog (#1071)', () => {
	const show = (props: Partial<Parameters<typeof FolderDialog>[0]> = {}) => {
		const onSave = vi.fn(async () => true);
		const onOpenChange = vi.fn();
		render(<FolderDialog open onOpenChange={onOpenChange} onSave={onSave} {...props} />);
		return { onSave, onOpenChange };
	};

	it('names a new folder with one verb throughout, and says what the instructions do', () => {
		show();
		expect(screen.getByRole('dialog', { name: 'New folder' })).toBeInTheDocument();
		const instructions = screen.getByLabelText('Instructions for chats in this folder (optional)');
		expect(instructions).toHaveAccessibleDescription('Added to every chat in this folder.');
		expect(instructions).not.toHaveAttribute('placeholder');
		expect(screen.getByLabelText('Name')).not.toHaveAttribute('placeholder');
		expect(screen.getByRole('button', { name: 'Create folder' })).toBeInTheDocument();
	});

	it('says an empty name at the field, not in a toast, and clears it once a name is typed (FRM-2)', async () => {
		const { onSave } = show();
		fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));

		const name = screen.getByLabelText('Name');
		expect(name).toHaveAttribute('aria-invalid', 'true');
		expect(name).toHaveAccessibleDescription('Enter a name for the folder.');
		expect(name).toHaveFocus();
		expect(toastError).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();

		fireEvent.change(name, { target: { value: 'Travel' } });
		expect(name).not.toHaveAttribute('aria-invalid');
		expect(screen.queryByText('Enter a name for the folder.')).not.toBeInTheDocument();
	});

	it('saves an edited folder with its trimmed name and instructions, then closes', async () => {
		let finish: (ok: boolean) => void = () => {};
		const onSave = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
		const { onOpenChange } = show({
			folder: { id: 'f1', name: 'Work', data: { system_prompt: 'Be formal' } },
			onSave
		});
		expect(screen.getByRole('dialog', { name: 'Edit folder' })).toBeInTheDocument();
		expect(screen.getByLabelText('Instructions for chats in this folder (optional)')).toHaveValue('Be formal');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Office  ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));

		const busy = await screen.findByRole('button', { name: /Saving…/ });
		expect(busy).toBeDisabled();
		expect(busy).toHaveAttribute('aria-busy', 'true');
		expect(onSave).toHaveBeenCalledWith({ name: 'Office', system_prompt: 'Be formal' });
		finish(true);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
