import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
	render(<RouterProvider router={router} />);
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
