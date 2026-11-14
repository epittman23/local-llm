import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addUser } from '@/lib/apis/auths';
import { useAuthStore } from '@/lib/stores/authStore';
import { AddUserModal } from './AddUserModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/auths', () => ({ addUser: vi.fn() }));
vi.mock('@/lib/utils/auth-helpers', () => ({ generateInitialsImage: () => 'initials.png' }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
});

const renderModal = () => {
	const onSaved = vi.fn();
	render(<AddUserModal open onOpenChange={vi.fn()} onSaved={onSaved} />);
	return onSaved;
};

describe('AddUserModal', () => {
	it('shows the single-user form first', () => {
		renderModal();
		expect(screen.getByLabelText('Name')).toBeTruthy();
		expect(screen.queryByText(/Click here to select a csv file/)).toBeNull();
	});

	it('switches to the CSV import tab and back to the form', () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'CSV Import' }));
		expect(screen.getByRole('button', { name: 'Click here to select a csv file.' })).toBeTruthy();
		expect(screen.queryByLabelText('Name')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Form' }));
		expect(screen.getByLabelText('Name')).toBeTruthy();
	});

	it('opens the file picker from the CSV select button', () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'CSV Import' }));
		const input = document.getElementById('upload-user-csv-input') as HTMLInputElement;
		const click = vi.spyOn(input, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Click here to select a csv file.' }));
		expect(click).toHaveBeenCalledTimes(1);
	});

	it('creates the user from the form and reports it saved', async () => {
		vi.mocked(addUser).mockResolvedValue({ id: 'u1' } as never);
		const onSaved = renderModal();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
		fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
		fireEvent.change(screen.getByLabelText('Enter Your Password'), { target: { value: 'pw123456' } });
		fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(addUser).toHaveBeenCalledWith('tok', 'Ada', 'ada@example.com', 'pw123456', 'admin', 'initials.png');
	});
});
