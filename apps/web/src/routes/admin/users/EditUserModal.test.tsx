import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { getUserGroupsById, updateUserById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { type AdminUser, EditUserModal } from './EditUserModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
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
		expect(screen.getByRole('combobox', { name: 'Role' }).textContent).toBe('User');
		expect(screen.getByRole('heading', { name: 'Edit user' })).toBeTruthy();
		expect(screen.getByPlaceholderText('New password (optional)')).toBeTruthy();
	});

	it('lists the groups the user belongs to', async () => {
		renderModal();
		expect(await screen.findByRole('link', { name: 'Research' })).toBeTruthy();
	});

	it('disables the role select on the signed-in admin own row', () => {
		useAuthStore.setState({ user: { id: 'u2' } } as never);
		renderModal();
		const role = screen.getByRole('combobox', { name: 'Role' }) as HTMLButtonElement;
		expect(role.disabled).toBe(true);
		expect(role.getAttribute('aria-describedby')).toBeTruthy();
		expect(screen.getByText("You can't change your own role.")).toBeTruthy();
	});

	it('saves the edits, then reports saved and closes', async () => {
		vi.mocked(updateUserById).mockResolvedValue({ id: 'u2' } as never);
		const { onSaved, onOpenChange } = renderModal();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Grace H  ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(updateUserById).toHaveBeenCalledWith(
			'tok',
			'u2',
			expect.objectContaining({ name: 'Grace H', role: 'user', password: '' })
		);
		expect(toast.success).toHaveBeenCalledWith('Saved “Grace H”');
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('stays open when the save fails', async () => {
		vi.mocked(updateUserById).mockRejectedValue('nope');
		const { onSaved, onOpenChange } = renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the user.", 'nope'));
		expect(onSaved).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it('shows empty and malformed fields under them, without saving', async () => {
		renderModal();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
		fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		expect(await screen.findByText('Enter their name.')).toBeTruthy();
		expect(screen.getByText('Enter an email address like name@example.com.')).toBeTruthy();
		expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
		expect(updateUserById).not.toHaveBeenCalled();
	});

	it('asks for an email when it is cleared', async () => {
		renderModal();
		fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		expect(await screen.findByText('Enter their email address.')).toBeTruthy();
	});

	it('marks a taken email on Email, and clears it once the email changes', async () => {
		vi.mocked(updateUserById).mockRejectedValue('Uh-oh! This email is already registered.');
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		expect(await screen.findByText('An account with this email already exists.')).toBeTruthy();
		expect(toastFailure).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace2@example.com' } });
		expect(screen.queryByText('An account with this email already exists.')).toBeNull();
	});

	it('puts a rejected password under New password', async () => {
		vi.mocked(updateUserById).mockRejectedValue('Password must be at least 8 characters.');
		renderModal();
		fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save user' }));
		expect(await screen.findByText('Password must be at least 8 characters.')).toBeTruthy();
	});

	it('lists the OAuth providers a user signs in with', () => {
		renderModal({ ...USER, oauth: { google: { sub: 'g-123' } } });
		expect(screen.getByText('Signs in with')).toBeTruthy();
		expect(screen.getByText('google')).toBeTruthy();
	});

	it('closes from Cancel', () => {
		const { onOpenChange } = renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
