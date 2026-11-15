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
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { copyToClipboard } from '@/lib/utils';
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
vi.mock('@/lib/apis/users', () => ({ getUserInfoById: vi.fn(), searchUsers: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn(async () => true)
}));

const ANYONE_READ = { principal_type: 'anyone', principal_id: '*', permission: 'read' };
const PUBLIC_READ = { principal_type: 'user', principal_id: '*', permission: 'read' };
const GROUP_READ = { principal_type: 'group', principal_id: 'g1', permission: 'read' };

const open = (onOpenChange = vi.fn()) => {
	const view = (isOpen: boolean) => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ShareChatDialog open={isOpen} onOpenChange={onOpenChange} chatId="c1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { rerender } = render(view(true));
	const reopen = () => {
		rerender(view(false));
		rerender(view(true));
	};
	return { onOpenChange, reopen };
};

const signIn = (permissions: object, role = 'user') =>
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { role, permissions } } as never);

const radio = (name: string) => screen.getByRole('radio', { name });
const create = () => screen.getByRole('button', { name: /Create and copy link/ });
/** The chat as the server holds it: not shared, then shared once the link exists. */
const sharedAfterCreate = () =>
	vi
		.mocked(getChatById)
		.mockResolvedValueOnce({ share_id: null } as never)
		.mockResolvedValue({ share_id: 's1' } as never);

beforeEach(() => {
	vi.clearAllMocks();
	signIn({ sharing: { public_chats: true, open_chats: true } });
	vi.mocked(searchUsers).mockResolvedValue({ users: [], total: 1 } as never);
});

describe('ShareChatDialog: asks who can open the link first (#1006, S2-D2)', () => {
	it('preselects nothing and creates nothing until a choice is made, saying why the action waits (ACT-5)', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		open();

		expect(await screen.findByRole('radiogroup', { name: 'Who can open the link' })).toBeInTheDocument();
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'false');
		expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'false');
		await waitFor(() => expect(create()).toBeDisabled());
		expect(create()).toHaveAccessibleDescription('Choose who can open the link first.');
		fireEvent.click(create());
		expect(shareChatById).not.toHaveBeenCalled();

		fireEvent.click(radio('Only me (signed in)'));
		expect(create()).toBeEnabled();
		expect(screen.queryByText('Choose who can open the link first.')).not.toBeInTheDocument();
	});

	it('"Anyone with the link" creates the link, grants anyone read, and copies it once that is stored', async () => {
		sharedAfterCreate();
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([ANYONE_READ] as never);
		const { onOpenChange } = open();

		fireEvent.click(await screen.findByRole('radio', { name: 'Anyone with the link' }));
		await waitFor(() => expect(create()).toBeEnabled());
		fireEvent.click(create());

		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(expect.stringMatching(/\/s\/s1$/)));
		expect(updateChatAccessGrants).toHaveBeenCalledWith('t', 'c1', [ANYONE_READ]);
		expect(toastSuccess).toHaveBeenCalledWith('Link copied');
		const link = await screen.findByRole('textbox', { name: 'Link' });
		expect(link).toHaveAttribute('readonly');
		expect((link as HTMLInputElement).value).toMatch(/\/s\/s1$/);
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Copy link' })).toHaveFocus());
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it('cannot be pressed twice while the link is being created, until the dialog knows it exists', async () => {
		let known: (v: unknown) => void = () => {};
		vi.mocked(getChatById)
			.mockResolvedValueOnce({ share_id: null } as never)
			.mockReturnValueOnce(new Promise((resolve) => (known = resolve)) as never)
			.mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		open();

		fireEvent.click(await screen.findByRole('radio', { name: 'Only me (signed in)' }));
		await waitFor(() => expect(create()).toBeEnabled());
		fireEvent.click(create());
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link copied'));
		// Copied, but the chat is not re-read yet: still busy.
		const busy = screen.getByRole('button', { name: /Creating…/ });
		expect(busy).toBeDisabled();
		expect(busy).toHaveAttribute('aria-busy', 'true');
		fireEvent.click(busy);
		known({ share_id: 's1' });

		expect(await screen.findByRole('textbox', { name: 'Link' })).toBeInTheDocument();
		expect(shareChatById).toHaveBeenCalledTimes(1);
	});

	it('"Only me (signed in)" creates the link with no grant and copies it', async () => {
		sharedAfterCreate();
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		open();

		fireEvent.click(await screen.findByRole('radio', { name: 'Only me (signed in)' }));
		await waitFor(() => expect(create()).toBeEnabled());
		fireEvent.click(create());

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link copied'));
		expect(updateChatAccessGrants).not.toHaveBeenCalled();
		expect(await screen.findByRole('textbox', { name: 'Link' })).toBeInTheDocument();
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
	});

	it('does not copy a link it says anyone can open when that grant was not stored', async () => {
		sharedAfterCreate();
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		// Stored without the anyone grant, as the server stores it for a user who may not set it.
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		open();

		fireEvent.click(await screen.findByRole('radio', { name: 'Anyone with the link' }));
		await waitFor(() => expect(create()).toBeEnabled());
		fireEvent.click(create());

		await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/only you can open it/)));
		expect(copyToClipboard).not.toHaveBeenCalled();
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
	});

	it('creates nothing more when the share itself fails', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		vi.mocked(shareChatById).mockRejectedValue('offline');
		open();

		fireEvent.click(await screen.findByRole('radio', { name: 'Anyone with the link' }));
		await waitFor(() => expect(create()).toBeEnabled());
		fireEvent.click(create());

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('offline'));
		expect(updateChatAccessGrants).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
		await waitFor(() => expect(create()).toBeEnabled());
	});

	it('forgets an earlier pick when opened again', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		const { reopen } = open();
		fireEvent.click(await screen.findByRole('radio', { name: 'Only me (signed in)' }));
		expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true');

		reopen();

		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'false'));
	});

	it('offers "Anyone with the link" only as the sharing permissions allow, saying why (ACT-5)', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		signIn({ sharing: { public_chats: true } });
		open();

		expect(await screen.findByRole('radio', { name: 'Anyone with the link' })).toBeDisabled();
		expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription(/do not allow links that anyone can open/);
	});

	it('offers an admin every choice, whatever the permissions say', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		signIn({}, 'admin');
		open();

		expect(await screen.findByRole('radio', { name: 'Anyone with the link' })).toBeEnabled();
	});
});

describe('ShareChatDialog: a chat that has a link (#334, #1006)', () => {
	it('shows the stored answer, the link, Copy link, Update snapshot and Stop sharing', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([ANYONE_READ] as never);
		open();

		await waitFor(() => expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true'));
		expect(getChatAccessGrants).toHaveBeenCalledWith('t', 'c1');
		expect(screen.getByRole('dialog', { name: 'Share chat' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Update snapshot' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(expect.stringMatching(/\/s\/s1$/)));
	});

	it('Update snapshot shares the chat again as it is now and leaves the dialog open', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(shareChatById).mockResolvedValue({ share_id: 's1' } as never);
		const { onOpenChange } = open();

		fireEvent.click(await screen.findByRole('button', { name: 'Update snapshot' }));

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Snapshot updated/)));
		expect(shareChatById).toHaveBeenCalledWith('t', 'c1');
		expect(updateChatAccessGrants).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it('saves a changed answer at once, then shows what was stored', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants)
			.mockResolvedValueOnce([])
			.mockResolvedValue([ANYONE_READ] as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
		fireEvent.click(radio('Anyone with the link'));

		await waitFor(() => expect(updateChatAccessGrants).toHaveBeenCalledWith('t', 'c1', [ANYONE_READ]));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Access updated'));
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true');
	});

	it('says so when the server keeps less than was sent', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
		fireEvent.click(radio('Anyone with the link'));

		await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(DROPPED_GRANTS_WARNING));
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it('"Only me" drops the wildcard grants and keeps named ones', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([ANYONE_READ, PUBLIC_READ, GROUP_READ] as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		await waitFor(() => expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true'));
		fireEvent.click(radio('Only me (signed in)'));

		await waitFor(() => expect(updateChatAccessGrants).toHaveBeenCalledWith('t', 'c1', [GROUP_READ]));
	});

	it('says a link every signed-in account may open as it is, with neither answer chosen', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([PUBLIC_READ] as never);
		open();

		expect(await screen.findByText('All signed-in accounts can open this link.')).toBeInTheDocument();
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'false');
		expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription('All signed-in accounts can open this link.');
		expect(screen.queryByText(/opens only while you are signed in/)).toBeNull();
	});

	it('"Make it only me" removes the every-account grant and keeps named ones', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants)
			.mockResolvedValueOnce([PUBLIC_READ, GROUP_READ] as never)
			.mockResolvedValue([GROUP_READ] as never);
		vi.mocked(updateChatAccessGrants).mockResolvedValue({ id: 'c1' } as never);
		open();

		fireEvent.click(await screen.findByRole('button', { name: 'Make it only me' }));

		await waitFor(() => expect(updateChatAccessGrants).toHaveBeenCalledWith('t', 'c1', [GROUP_READ]));
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
		expect(screen.queryByText('All signed-in accounts can open this link.')).toBeNull();
	});

	it('still gives the reason "Anyone" cannot be chosen beside the every-account note (ACT-5)', async () => {
		signIn({ sharing: { public_chats: true, open_chats: false } });
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([PUBLIC_READ] as never);
		open();

		expect(
			await screen.findByText(/All signed-in accounts can open this link\. Your sharing permissions/)
		).toBeInTheDocument();
		expect(radio('Anyone with the link')).toBeDisabled();
	});

	it('goes back to what was stored when a save fails', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(updateChatAccessGrants).mockRejectedValue('refused');
		open();

		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
		fireEvent.click(radio('Anyone with the link'));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('refused'));
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));
	});

	it('sends two quick changes one after the other, and reports only the last', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		let stored: unknown[] = [];
		vi.mocked(getChatAccessGrants).mockImplementation(async () => stored as never);
		let release: () => void = () => {};
		const order: string[] = [];
		vi.mocked(updateChatAccessGrants).mockImplementation(async (_t, _id, grants) => {
			const label = (grants as unknown[]).length ? 'anyone' : 'me';
			order.push(`start ${label}`);
			if (label === 'anyone') await new Promise<void>((resolve) => (release = resolve));
			stored = grants as unknown[];
			order.push(`end ${label}`);
			return { id: 'c1' } as never;
		});
		open();
		await waitFor(() => expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true'));

		fireEvent.click(radio('Anyone with the link'));
		await waitFor(() => expect(order).toEqual(['start anyone']));
		fireEvent.click(radio('Only me (signed in)'));
		release();

		await waitFor(() => expect(order).toEqual(['start anyone', 'end anyone', 'start me', 'end me']));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastWarning).not.toHaveBeenCalled();
		expect(radio('Only me (signed in)')).toHaveAttribute('aria-checked', 'true');
	});

	it('Stop sharing removes the link and asks the question again', async () => {
		vi.mocked(getChatById)
			.mockResolvedValueOnce({ share_id: 's1' } as never)
			.mockResolvedValue({ share_id: null } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([ANYONE_READ] as never);
		vi.mocked(deleteSharedChatById).mockResolvedValue(true as never);
		open();
		await waitFor(() => expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true'));

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		await waitFor(() => expect(deleteSharedChatById).toHaveBeenCalledWith('t', 'c1'));
		expect(await screen.findByRole('button', { name: /Create and copy link/ })).toBeDisabled();
		expect(screen.queryByRole('textbox', { name: 'Link' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'false');
	});

	it('keeps the link when deleting it fails', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([ANYONE_READ] as never);
		vi.mocked(deleteSharedChatById).mockRejectedValue('not now');
		open();
		await waitFor(() => expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true'));

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('not now'));
		expect(radio('Anyone with the link')).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('textbox', { name: 'Link' })).toBeInTheDocument();
	});
});

describe('ShareChatDialog: users and groups (WRD-4)', () => {
	it('hides the access list while only one account exists', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		open();

		await waitFor(() => expect(searchUsers).toHaveBeenCalledWith('t'));
		await screen.findByRole('textbox', { name: 'Link' });
		expect(screen.queryByText('Access List')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
	});

	it('hides it when the account count cannot be read', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(searchUsers).mockRejectedValue('nope');
		open();

		await waitFor(() => expect(searchUsers).toHaveBeenCalled());
		await screen.findByRole('textbox', { name: 'Link' });
		expect(screen.queryByText('Access List')).not.toBeInTheDocument();
	});

	it('shows the access list, without a second visibility picker, when several accounts exist', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: 's1' } as never);
		vi.mocked(getChatAccessGrants).mockResolvedValue([]);
		vi.mocked(searchUsers).mockResolvedValue({ users: [], total: 3 } as never);
		open();

		expect(await screen.findByText('Access List')).toBeInTheDocument();
		expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
	});

	it('is not counted for a chat without a link', async () => {
		vi.mocked(getChatById).mockResolvedValue({ share_id: null } as never);
		open();

		await screen.findByRole('radiogroup', { name: 'Who can open the link' });
		expect(searchUsers).not.toHaveBeenCalled();
		expect(getChatAccessGrants).not.toHaveBeenCalled();
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
