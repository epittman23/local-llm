import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addUser } from '@/lib/apis/auths';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { AddUserModal, addUserProblem, generatePassword, importSummary } from './AddUserModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/auths', () => ({ addUser: vi.fn() }));
vi.mock('@/lib/utils/auth-helpers', () => ({ generateInitialsImage: () => 'initials.png' }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { name: 'local-llm', version: '', features: {} } });
});

const renderModal = () => {
	const onSaved = vi.fn();
	render(<AddUserModal open onOpenChange={vi.fn()} onSaved={onSaved} />);
	return onSaved;
};
const fill = () => {
	fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
	fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
	fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
};

describe('AddUserModal', () => {
	it('shows the single-user form first', () => {
		renderModal();
		expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'Full name');
		expect(screen.getByLabelText('Email')).toHaveAttribute('placeholder', 'name@example.com');
		expect(screen.queryByRole('button', { name: 'Choose CSV file' })).toBeNull();
	});

	it('switches to the CSV import and back to the form', () => {
		renderModal();
		fireEvent.click(screen.getByRole('radio', { name: 'Import from CSV' }));
		expect(screen.getByRole('button', { name: 'Choose CSV file' })).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Download template' })).toHaveAttribute('download');
		expect(screen.queryByLabelText('Name')).toBeNull();
		fireEvent.click(screen.getByRole('radio', { name: 'One user' }));
		expect(screen.getByLabelText('Name')).toBeTruthy();
	});

	it('asks for a file under the drop zone rather than in a toast', () => {
		renderModal();
		fireEvent.click(screen.getByRole('radio', { name: 'Import from CSV' }));
		fireEvent.click(screen.getByRole('button', { name: 'Import users' }));
		expect(screen.getByText('Choose a CSV file to import.')).toBeInTheDocument();
	});

	it('creates the user from the form and reports it saved', async () => {
		vi.mocked(addUser).mockResolvedValue({ id: 'u1' } as never);
		const onSaved = renderModal();
		fill();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(addUser).toHaveBeenCalledWith('tok', 'Ada', 'ada@example.com', 'pw123456', 'user', 'initials.png');
	});

	it('shows each empty field’s error under it, with no request (FRM-2)', () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		expect(screen.getByText('Enter their name.')).toBeInTheDocument();
		expect(screen.getByText('Enter their email address.')).toBeInTheDocument();
		expect(screen.getByText('Enter a password, or press Generate.')).toBeInTheDocument();
		expect(addUser).not.toHaveBeenCalled();
	});

	it('marks a duplicate email on Email (#1103)', async () => {
		vi.mocked(addUser).mockRejectedValue('Uh-oh! This email is already registered. Sign in…');
		renderModal();
		fill();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		expect(await screen.findByText('An account with this email already exists.')).toBeInTheDocument();
		expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
	});

	it('shows the server’s password rule only while it is on, and generates a password (S5-D8)', () => {
		useConfigStore.setState({
			config: {
				name: 'local-llm',
				version: '',
				features: { enable_password_validation: true, password_validation_hint: 'At least 12 characters.' }
			}
		});
		renderModal();
		expect(screen.getByText('At least 12 characters.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
		expect((screen.getByLabelText('Password') as HTMLInputElement).value).toHaveLength(16);
	});
});

describe('AddUserModal helpers', () => {
	it('says a password problem right under its field, with Generate and Copy beside it, not between (#1103)', () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		const field = screen.getByLabelText('Password').closest('[data-composite-field]') as HTMLElement;
		const message = field.nextElementSibling as HTMLElement;
		expect(message).toHaveTextContent('Enter a password, or press Generate.');
		expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter a password, or press Generate.');
		expect(field.parentElement).not.toContainElement(screen.getByRole('button', { name: 'Generate' }));
		expect(field.parentElement).not.toContainElement(screen.getByRole('button', { name: 'Copy' }));
	});

	it('generates 16 characters with every class', () => {
		const pw = generatePassword();
		expect(pw).toHaveLength(16);
		expect(pw).toMatch(/[a-z]/);
		expect(pw).toMatch(/[A-Z]/);
		expect(pw).toMatch(/[0-9]/);
		expect(pw).toMatch(/[^A-Za-z0-9]/);
	});

	it('places server answers under their fields, and words an import', () => {
		expect(addUserProblem('This email is already registered')?.field).toBe('email');
		expect(addUserProblem('The password does not meet the rule')?.field).toBe('password');
		expect(addUserProblem('boom')).toBeNull();
		expect(importSummary(3, 0)).toBe('3 users added');
		expect(importSummary(1, 0)).toBe('1 user added');
		expect(importSummary(3, 1)).toBe('3 added, 1 failed');
		expect(importSummary(0, 2)).toBe("2 users couldn't be added");
	});
});

describe('Closing Add user with unsaved changes (FRM-3)', () => {
	it('closes at once while empty; after typing, Escape asks and Keep editing returns to the field', async () => {
		const onOpenChange = vi.fn();
		render(<AddUserModal open onOpenChange={onOpenChange} onSaved={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		const name = screen.getByLabelText('Name');
		fireEvent.change(name, { target: { value: 'Ada' } });
		name.focus();
		fireEvent.keyDown(name, { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This account is not added yet.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
		expect(onOpenChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('closes without asking once the user is added', async () => {
		vi.mocked(addUser).mockResolvedValue({ id: 'u1' } as never);
		const onOpenChange = vi.fn();
		render(<AddUserModal open onOpenChange={onOpenChange} onSaved={vi.fn()} />);
		fill();
		fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});
});
