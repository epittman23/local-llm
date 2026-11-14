import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserGroupsById, updateUserById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { type AdminUser, EditUserModal } from './EditUserModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/users', () => ({ getUserGroupsById: vi.fn(), updateUserById: vi.fn() }));

const USER: AdminUser = {
	id: 'u2',
	name: 'Grace',
	email: 'grace@example.com',
	role: 'user',
	profile_image_url: '/p.png',
	created_at: 1700000000,
	last_active_at: 1700000100
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getUserGroupsById).mockResolvedValue([{ id: 'g1', name: 'Research' }] as never);
	useAuthStore.setState({ token: 'tok', user: { id: 'admin1' } } as never);
});

const renderModal = (selectedUser: AdminUser = USER) => {
	const onSaved = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<EditUserModal open onOpenChange={onOpenChange} selectedUser={selectedUser} onSaved={onSaved} />
			</MemoryRouter>
		</QueryClientProvider>
	);
	return { onSaved, onOpenChange };
};

describe('EditUserModal', () => {
	it('fills the form from the selected user', () => {
		renderModal();
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Grace');
		expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('grace@example.com');
		expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('user');
	});

	it('lists the groups the user belongs to', async () => {
		renderModal();
		expect(await screen.findByRole('link', { name: 'Research' })).toBeTruthy();
	});

	it('disables the role select on the signed-in admin own row', () => {
		useAuthStore.setState({ user: { id: 'u2' } } as never);
		renderModal();
		expect((screen.getByLabelText('Role') as HTMLSelectElement).disabled).toBe(true);
	});

	it('saves the edits, then reports saved and closes', async () => {
		vi.mocked(updateUserById).mockResolvedValue({ id: 'u2' } as never);
		const { onSaved, onOpenChange } = renderModal();
		fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(updateUserById).toHaveBeenCalledWith('tok', 'u2', expect.objectContaining({ role: 'admin', password: '' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('stays open when the save fails', async () => {
		vi.mocked(updateUserById).mockRejectedValue('nope');
		const { onSaved, onOpenChange } = renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateUserById).toHaveBeenCalled());
		expect(onSaved).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});
