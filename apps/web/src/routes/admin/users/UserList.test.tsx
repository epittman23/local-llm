import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { addUser } from '@/lib/apis/auths';
import { deleteUserById, getUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { UserList } from './UserList';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/users', () => ({
	deleteUserById: vi.fn(),
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
	it('offers chats, preview and delete only on non-admin rows', async () => {
		await renderList();
		expect(screen.getAllByRole('button', { name: 'Edit User' })).toHaveLength(2);
		expect(screen.getAllByRole('button', { name: 'Chats' })).toHaveLength(1);
		expect(screen.getAllByRole('button', { name: 'Preview Access' })).toHaveLength(1);
		expect(screen.getAllByRole('button', { name: 'Delete User' })).toHaveLength(1);
	});

	it('opens the chats dialog for a user', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
		expect(await screen.findByText('Chats of Ben')).toBeTruthy();
	});

	it('opens the access preview for a user', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Preview Access' }));
		expect(await screen.findByText('Access preview of Ben')).toBeTruthy();
	});

	it('opens the edit dialog from the role button', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Role: user, change' }));
		expect(await screen.findByText('Edit User', { selector: '[role="dialog"] *' })).toBeTruthy();
	});

	it('confirms before deleting, then deletes the user', async () => {
		vi.mocked(deleteUserById).mockResolvedValue(true as never);
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Delete User' }));
		expect(await screen.findByText('Delete user?')).toBeTruthy();
		expect(deleteUserById).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(deleteUserById).toHaveBeenCalledWith('tok', 'b'));
	});

	it('recounts the accounts after a delete, so the workspace shows owners again without a reload', async () => {
		vi.mocked(deleteUserById).mockResolvedValue(true as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(['account-count'], 2);
		await renderList(client);
		fireEvent.click(screen.getByRole('button', { name: 'Delete User' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(client.getQueryState(['account-count'])?.isInvalidated).toBe(true));
	});

	it('recounts the accounts after a user is added (the form and the CSV import both report through onSaved)', async () => {
		vi.mocked(addUser).mockResolvedValue({ id: 'c' } as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(['account-count'], 1);
		await renderList(client);
		fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
		const dialog = await screen.findByRole('dialog');
		fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
		await waitFor(() => expect(client.getQueryState(['account-count'])?.isInvalidated).toBe(true));
	});

	it('opens the Add User dialog', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
		expect(await screen.findByText('Create a user, or import several from a CSV file.')).toBeTruthy();
	});

	it('clears the search box from the clear button', async () => {
		await renderList();
		const box = screen.getByLabelText('Search') as HTMLInputElement;
		fireEvent.change(box, { target: { value: 'be' } });
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(box.value).toBe('');
	});
});

describe('UserList table (#987, #1062)', () => {
	it('names each role button by the role it shows and what it does', async () => {
		await renderList();
		expect(screen.getByRole('button', { name: 'Role: admin, change' })).toHaveTextContent('admin');
		expect(screen.getByRole('button', { name: 'Role: user, change' })).toHaveTextContent('user');
	});

	it('gives the actions column a header a screen reader can read', async () => {
		await renderList();
		expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
	});

	it('sits in the shared table container, labelled, with the dates left out on a phone', async () => {
		await renderList();
		expect(screen.getByRole('region', { name: 'Users' })).toHaveAttribute('data-slot', 'table-container');
		expect(screen.getByRole('columnheader', { name: /Last Active/ }).className).toContain('hidden md:table-cell');
		expect(screen.getByRole('columnheader', { name: /Created at/ }).className).toContain('hidden md:table-cell');
		expect(screen.getByRole('columnheader', { name: /Name/ }).className).not.toContain('hidden');
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
