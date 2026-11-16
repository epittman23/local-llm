import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { addUser } from '@/lib/apis/auths';
import { deleteUserById, getUsers, updateUserById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { lastActive, UserList } from './UserList';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/users', () => ({
	deleteUserById: vi.fn(),
	updateUserById: vi.fn(),
	getUsers: vi.fn(),
	getUserGroupsById: vi.fn().mockResolvedValue([])
}));
vi.mock('@/lib/apis/auths', () => ({ addUser: vi.fn() }));
vi.mock('./UserChatsModal', () => ({
	UserChatsModal: ({ open, user }: { open: boolean; user: { name: string } }) =>
		open ? <div role="dialog">Chats of {user.name}</div> : null
}));
vi.mock('./UserPreviewModal', () => ({
	UserPreviewModal: ({ open, userName }: { open: boolean; userName: string }) =>
		open ? <div role="dialog">Access preview of {userName}</div> : null
}));

const openMenu = async (name: string) => {
	fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, pointerType: 'mouse' });
	return screen.findByRole('menu');
};

const row = (id: string, name: string, role: string) => ({
	id,
	name,
	email: `${name.toLowerCase()}@example.com`,
	role,
	profile_image_url: '',
	created_at: 1700000000,
	last_active_at: 1700000100
});

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok', user: { id: 'a' } } as never);
	useConfigStore.setState({ config: { features: { enable_admin_chat_access: true } } } as never);
	vi.mocked(getUsers).mockResolvedValue({
		users: [row('a', 'Ada', 'admin'), row('b', 'Ben', 'user')],
		total: 2
	} as never);
});

const renderList = async (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<TooltipProvider>
					<UserList />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
	await screen.findByText('Ben');
};

describe('UserList', () => {
	it("keeps Edit on every row and puts chats, preview and delete in a labelled menu on others' rows", async () => {
		await renderList();
		expect(screen.getByRole('button', { name: 'Edit Ada' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Edit Ben' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'More actions for Ada' })).toBeNull();
		const menu = await openMenu('More actions for Ben');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((m) => m.textContent)
		).toEqual(['View chats', 'Preview access', 'Delete user']);
	});

	it('opens the chats dialog for a user', async () => {
		await renderList();
		fireEvent.click(within(await openMenu('More actions for Ben')).getByRole('menuitem', { name: 'View chats' }));
		expect(await screen.findByText('Chats of Ben')).toBeTruthy();
	});

	it('opens the access preview for a user', async () => {
		await renderList();
		fireEvent.click(within(await openMenu('More actions for Ben')).getByRole('menuitem', { name: 'Preview access' }));
		expect(await screen.findByText('Access preview of Ben')).toBeTruthy();
	});

	it('opens the edit dialog from Edit', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Ben' }));
		expect(await screen.findByRole('heading', { name: 'Edit user' })).toBeTruthy();
	});

	it('confirms before deleting, naming the user and what goes (ACT-3), then deletes', async () => {
		vi.mocked(deleteUserById).mockResolvedValue(true as never);
		await renderList();
		fireEvent.click(within(await openMenu('More actions for Ben')).getByRole('menuitem', { name: 'Delete user' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Ben”?' });
		expect(dialog).toHaveTextContent('Their account, chats, files, notes and memories are deleted.');
		expect(deleteUserById).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete user' }));
		await waitFor(() => expect(deleteUserById).toHaveBeenCalledWith('tok', 'b'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted “Ben”'));
	});

	it('recounts the accounts after a delete, so the workspace shows owners again without a reload', async () => {
		vi.mocked(deleteUserById).mockResolvedValue(true as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(['account-count'], 2);
		await renderList(client);
		fireEvent.click(within(await openMenu('More actions for Ben')).getByRole('menuitem', { name: 'Delete user' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete user' }));
		await waitFor(() => expect(client.getQueryState(['account-count'])?.isInvalidated).toBe(true));
	});

	it('recounts the accounts after a user is added (the form and the CSV import both report through onSaved)', async () => {
		vi.mocked(addUser).mockResolvedValue({ id: 'c' } as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(['account-count'], 1);
		await renderList(client);
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		const dialog = await screen.findByRole('dialog');
		fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Cleo' } });
		fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'cleo@example.com' } });
		fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'temporary-pass' } });
		fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
		await waitFor(() => expect(client.getQueryState(['account-count'])?.isInvalidated).toBe(true));
	});

	it('opens the Add user dialog', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		expect(await screen.findByRole('dialog', { name: 'Add user' })).toBeInTheDocument();
	});

	it('clears the search box from the clear button', async () => {
		await renderList();
		const box = screen.getByLabelText('Search users') as HTMLInputElement;
		fireEvent.change(box, { target: { value: 'be' } });
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(box.value).toBe('');
	});

	it('says nothing matched a search, and clears it (STA-3)', async () => {
		await renderList();
		vi.mocked(getUsers).mockResolvedValue({ users: [], total: 0 } as never);
		fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'zed' } });
		expect(await screen.findByRole('heading', { name: 'Nothing matches “zed”' })).toBeInTheDocument();
	});
});

describe('UserList roles (#1026)', () => {
	it('changes a role from its own menu, not the whole Edit dialog, and says so', async () => {
		vi.mocked(updateUserById).mockResolvedValue({ id: 'b' } as never);
		await renderList();
		const [trigger] = screen.getAllByRole('button', { name: 'Role: User' });
		// A chip: secondary beside the name, its 44 px touch target from standard.css (LAY-3).
		expect(trigger).toHaveAttribute('data-size', 'chip');
		fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
		fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: 'Pending' }));
		await waitFor(() =>
			expect(updateUserById).toHaveBeenCalledWith('tok', 'b', expect.objectContaining({ role: 'pending', name: 'Ben' }))
		);
		expect(toast.success).toHaveBeenCalledWith('“Ben” is now pending');
		expect(screen.queryByText('Edit User', { selector: '[role="dialog"] *' })).toBeNull();
	});

	it('shows your own role as a badge, not a control', async () => {
		await renderList();
		expect(screen.queryByRole('button', { name: 'Role: Admin' })).toBeNull();
		expect(screen.getAllByText('Admin')[0].dataset.slot).toBe('badge');
		expect(screen.getByText('(you)')).toBeInTheDocument();
	});

	it('reads Never for an account that has not been active', () => {
		expect(lastActive(null)).toBe('Never');
		expect(lastActive(0)).toBe('Never');
		expect(lastActive(Date.now() / 1000 - 3600)).toBe('an hour ago');
	});
});

describe('UserList table (#987, #1062)', () => {
	it('names each role control by the role it shows', async () => {
		await renderList();
		for (const button of screen.getAllByRole('button', { name: 'Role: User' }))
			expect(button).toHaveTextContent('User');
	});

	it('gives the actions column a header a screen reader can read', async () => {
		await renderList();
		expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
	});

	it('sits in the shared table container, labelled, with the first column kept in view', async () => {
		await renderList();
		const region = screen.getByRole('region', { name: 'Users' });
		expect(region).toHaveAttribute('data-slot', 'table-container');
		expect(within(region).getByRole('table')).toHaveAttribute('data-sticky-first-column', 'true');
		expect(screen.getByRole('columnheader', { name: /Last active/ })).toHaveClass('hidden', 'md:table-cell');
		expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveClass('hidden', 'md:table-cell');
		expect(screen.getByRole('columnheader', { name: /Email/ })).toHaveClass('hidden', 'sm:table-cell');
		expect(screen.getByRole('columnheader', { name: /Name/ }).className).not.toContain('hidden');
	});

	it('gives a truncated name and email their whole text in a title', async () => {
		await renderList();
		expect(screen.getByText('Ben')).toHaveAttribute('title', 'Ben');
		expect(screen.getAllByText('ben@example.com')[0]).toHaveAttribute('title', 'ben@example.com');
	});
});

describe('UserList when the load fails (STA-4, #981)', () => {
	it('shows the failure in place of a spinner that never ends, with no toast, and tries again', async () => {
		vi.mocked(getUsers).mockRejectedValue('Database is locked');
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter>
					<TooltipProvider>
						<UserList />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>
		);

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load users");
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		vi.mocked(getUsers).mockResolvedValue({ users: [row('b', 'Ben', 'user')], total: 1 } as never);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Ben')).toBeInTheDocument();
	});
});
