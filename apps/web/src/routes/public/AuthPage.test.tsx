import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { userSignIn } from '@/lib/apis/auths';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { AuthPage } from './AuthPage';

vi.mock('@/lib/apis', () => ({ getBackendConfig: vi.fn(async () => null) }));
vi.mock('@/lib/apis/auths', () => ({
	getSessionUser: vi.fn(),
	updateUserTimezone: vi.fn(),
	userSignIn: vi.fn(),
	userSignUp: vi.fn()
}));

const config = { name: 'local-llm', features: { auth: true, enable_login_form: true } };

function renderAt(url: string) {
	const router = createMemoryRouter(
		[
			{ path: '/auth', element: <AuthPage /> },
			{ path: '/error', element: <p>error page</p> }
		],
		{ initialEntries: [url] }
	);
	render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>
	);
	return router;
}

describe('AuthPage', () => {
	afterEach(() => {
		useAuthStore.setState({ status: 'pending', token: null, user: null });
		useConfigStore.setState({ config: null });
		localStorage.clear();
	});

	it('is a main landmark with one h1 naming the app', async () => {
		useConfigStore.setState({ config: config as never });
		useAuthStore.setState({ status: 'anonymous' });
		renderAt('/auth');

		expect(await screen.findByRole('main')).toBeInTheDocument();
		const headings = screen.getAllByRole('heading', { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0]).toHaveTextContent('Sign in to local-llm');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('says in place that the session expired (#1061)', async () => {
		useConfigStore.setState({ config: config as never });
		useAuthStore.setState({ status: 'anonymous' });
		renderAt('/auth?redirect=%2Fc%2Fabc&reason=expired');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('Your session expired. Sign in to continue where you left off.');
		// The standard's dense text size (TYP-2), not a raw Tailwind one.
		expect(alert).toHaveClass('text-dense');
		expect(alert).not.toHaveClass('text-sm');
	});

	it('puts focus in Email, with an example rather than an instruction as its placeholder (#1004)', async () => {
		useConfigStore.setState({ config: config as never });
		useAuthStore.setState({ status: 'anonymous' });
		renderAt('/auth');

		const email = await screen.findByLabelText('Email');
		await waitFor(() => expect(email).toHaveFocus());
		expect(email).toHaveAttribute('placeholder', 'you@example.com');
		expect(screen.getByLabelText('Password')).not.toHaveAttribute('placeholder');
	});

	it('shows and hides the password from a named button inside the field', async () => {
		useConfigStore.setState({ config: config as never });
		useAuthStore.setState({ status: 'anonymous' });
		renderAt('/auth');

		const password = await screen.findByLabelText('Password');
		expect(password).toHaveAttribute('type', 'password');
		fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
		expect(password).toHaveAttribute('type', 'text');
		fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
		expect(password).toHaveAttribute('type', 'password');
	});

	it('announces a failed sign-in and selects the password, so typing replaces it', async () => {
		useConfigStore.setState({ config: config as never });
		useAuthStore.setState({ status: 'anonymous' });
		vi.mocked(userSignIn).mockRejectedValueOnce('Incorrect email or password');
		renderAt('/auth');

		fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.com' } });
		const password = screen.getByLabelText('Password') as HTMLInputElement;
		fireEvent.change(password, { target: { value: 'wrong-password' } });
		fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

		expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
		await waitFor(() => expect(password).toHaveFocus());
		expect((password.selectionEnd ?? 0) - (password.selectionStart ?? 0)).toBe('wrong-password'.length);
	});

	it('focuses Name when signing up, in sentence case throughout', async () => {
		useConfigStore.setState({
			config: {
				...config,
				features: { ...config.features, enable_signup: true, enable_signup_password_confirmation: true }
			} as never
		});
		useAuthStore.setState({ status: 'anonymous' });
		renderAt('/auth');

		fireEvent.click(await screen.findByRole('button', { name: 'Sign up' }));
		await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
		expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
	});

	it('shows the boot splash, not a bare "Loading…", while the session is restored (STA-2)', () => {
		renderAt('/auth');
		expect(screen.getByText('local-llm')).toBeInTheDocument();
		expect(screen.queryByText('Loading…')).toBeNull();
	});

	it('sends an unreachable server to /error, keeping where the person was going', async () => {
		useAuthStore.setState({ status: 'anonymous' });
		const router = renderAt('/auth?redirect=%2Fnotes');

		expect(await screen.findByText('error page')).toBeInTheDocument();
		await waitFor(() => expect(router.state.location.search).toBe('?redirect=%2Fnotes'));
	});

	it('sends it to a bare /error when there was nowhere to go back to', async () => {
		useAuthStore.setState({ status: 'anonymous' });
		const router = renderAt('/auth');

		expect(await screen.findByText('error page')).toBeInTheDocument();
		expect(router.state.location.search).toBe('');
	});
});
