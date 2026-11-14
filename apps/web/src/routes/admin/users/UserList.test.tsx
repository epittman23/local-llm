import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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

const renderList = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
		fireEvent.click(screen.getAllByRole('button', { name: 'Change User Role' })[1]);
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
