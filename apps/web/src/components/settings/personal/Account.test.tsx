import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auths from '@/lib/apis/auths';
import * as users from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Account from './Account';

vi.mock('@/lib/apis/auths', async (original) => ({
	...(await original<typeof import('@/lib/apis/auths')>()),
	getSessionUser: vi.fn(),
	updateUserProfile: vi.fn(),
	updateUserPassword: vi.fn(),
	getAPIKey: vi.fn()
}));
vi.mock('@/lib/apis/users', async (original) => ({
	...(await original<typeof import('@/lib/apis/users')>()),
	getUserVariables: vi.fn(),
	updateUserVariables: vi.fn()
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', async (original) => ({
	...(await original<typeof import('@/lib/auth/session')>()),
	signOut: vi.fn()
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const sessionUser = {
	id: 'u1',
	name: 'Ann',
	profile_image_url: 'data:image/png;base64,AAAA',
	bio: 'my bio',
	gender: 'female',
	date_of_birth: '1990-01-02'
};

const saveButton = () => screen.getByRole('button', { name: 'Save' });

describe('Account tab after its loads (#259)', () => {
	beforeEach(() => {
		// The session as sign-in leaves it: no bio, gender or birth date, and the image route.
		useAuthStore.setState({
			token: 'jwt',
			user: { id: 'u1', name: 'Ann', role: 'user', profile_image_url: '/api/v1/users/u1/profile/image' }
		} as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', features: { enable_api_keys: false } } } as never);
		vi.mocked(auths.getSessionUser).mockResolvedValue(sessionUser);
		vi.mocked(users.getUserVariables).mockResolvedValue({ variables: { team: 'a' } });
		vi.mocked(auths.updateUserProfile).mockImplementation(async (_t, body) => ({ id: 'u1', ...body }));
		vi.mocked(users.updateUserVariables).mockImplementation(async (_t, variables) => ({ variables }));
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('saves what it loaded', async () => {
		render(<Account />);
		await screen.findByDisplayValue('my bio');
		expect(saveButton()).toBeEnabled();
		fireEvent.click(saveButton());
		await waitFor(() => expect(users.updateUserVariables).toHaveBeenCalledWith('jwt', { team: 'a' }));
		expect(auths.updateUserProfile).toHaveBeenCalledWith('jwt', {
			name: 'Ann',
			profile_image_url: 'data:image/png;base64,AAAA',
			bio: 'my bio',
			gender: 'female',
			date_of_birth: '1990-01-02'
		});
		expect(toastError).not.toHaveBeenCalled();
	});

	it.each([
		[
			'the profile',
			() => vi.mocked(auths.getSessionUser).mockRejectedValue('profile load failed'),
			'profile load failed'
		],
		[
			'the variables',
			() => vi.mocked(users.getUserVariables).mockRejectedValue('variables load failed'),
			'variables load failed'
		]
	])('shows the error and will not save when loading %s fails', async (_what, fail, message) => {
		fail();
		render(<Account />);
		await screen.findByLabelText('Name');
		await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
		expect(saveButton()).toBeDisabled();
		expect(screen.getByText(/didn't load/)).toBeInTheDocument();
		// Enter in a field submits the form even without the button.
		fireEvent.submit(saveButton().closest('form') as HTMLFormElement);
		await Promise.resolve();
		expect(auths.updateUserProfile).not.toHaveBeenCalled();
		expect(users.updateUserVariables).not.toHaveBeenCalled();
	});

	it('says nothing about a load that fails after the tab is closed', async () => {
		let reject: (reason: unknown) => void = () => {};
		vi.mocked(auths.getSessionUser).mockReturnValue(
			new Promise((_resolve, fail) => {
				reject = fail;
			})
		);
		const { unmount } = render(<Account />);
		expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
		unmount();
		reject('profile load failed');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe('Account tab: the password fields have a form of their own (#260)', () => {
	beforeEach(() => {
		useAuthStore.setState({
			token: 'jwt',
			user: { id: 'u1', name: 'Ann', role: 'user', profile_image_url: '/api/v1/users/u1/profile/image' }
		} as never);
		useConfigStore.setState({
			config: {
				name: 'x',
				version: '1',
				features: { enable_api_keys: false, enable_login_form: true, enable_password_change_form: true }
			}
		} as never);
		vi.mocked(auths.getSessionUser).mockResolvedValue(sessionUser);
		vi.mocked(users.getUserVariables).mockResolvedValue({ variables: {} });
		vi.mocked(auths.updateUserPassword).mockResolvedValue(true);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	const fill = async () => {
		render(<Account />);
		const current = await screen.findByLabelText('Current Password');
		fireEvent.change(current, { target: { value: 'old-pass' } });
		fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'new-pass' } });
		fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'new-pass' } });
		return current as HTMLInputElement;
	};

	it('submitting it changes the password and saves nothing else', async () => {
		const current = await fill();
		// What Enter in a password field submits is the form its `form=` names, a
		// form outside the tab's. (happy-dom ignores `form=`; the e2e spec presses Enter.)
		const form = document.getElementById(current.getAttribute('form') ?? '') as HTMLFormElement;
		expect(form).toHaveAttribute('aria-label', 'Change Password');
		expect(saveButton().closest('form')?.contains(form)).toBe(false);
		for (const field of ['New Password', 'Confirm Password'])
			expect(screen.getByLabelText(field)).toHaveAttribute('form', form.id);
		expect(screen.getByRole('button', { name: 'Update password' })).toHaveAttribute('form', form.id);
		fireEvent.submit(form);
		await waitFor(() => expect(auths.updateUserPassword).toHaveBeenCalledWith('jwt', 'old-pass', 'new-pass'));
		expect(auths.updateUserProfile).not.toHaveBeenCalled();
		expect(users.updateUserVariables).not.toHaveBeenCalled();
	});

	it('does nothing while a password is missing', async () => {
		render(<Account />);
		const current = await screen.findByLabelText('Current Password');
		fireEvent.submit(document.getElementById(current.getAttribute('form') ?? '') as HTMLFormElement);
		await Promise.resolve();
		expect(auths.updateUserPassword).not.toHaveBeenCalled();
	});

	it("the tab's Save does not change the password", async () => {
		vi.mocked(auths.updateUserProfile).mockImplementation(async (_t, body) => ({ id: 'u1', ...body }));
		vi.mocked(users.updateUserVariables).mockImplementation(async (_t, variables) => ({ variables }));
		await fill();
		fireEvent.click(saveButton());
		await waitFor(() => expect(auths.updateUserProfile).toHaveBeenCalled());
		expect(auths.updateUserPassword).not.toHaveBeenCalled();
	});
});
