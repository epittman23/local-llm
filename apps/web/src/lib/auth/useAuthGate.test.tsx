import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useAuthGate } from './useAuthGate';

// A tiny host so useAuthGate runs inside real router context -- matching how
// AppShell.tsx actually calls it, and how AppRouter.tsx builds its router
// (createBrowserRouter, the data router), not the older declarative
// <MemoryRouter> component (which double-mounts its children on init and
// would make every assertion below count two identical calls instead of one).
function GateProbe() {
	useAuthGate();
	return <div>protected content</div>;
}

function renderGate(initialPath: string) {
	const router = createMemoryRouter(
		[
			{ path: '*', element: <GateProbe /> },
			{ path: '/auth', element: <div>auth page</div> }
		],
		{ initialEntries: [initialPath] }
	);
	return { router, ...render(<RouterProvider router={router} />) };
}

describe('useAuthGate', () => {
	afterEach(() => {
		useAuthStore.setState({ status: 'pending', token: null, user: null });
	});

	it('does nothing while the session bootstrap is still pending', () => {
		useAuthStore.setState({ status: 'pending' });

		const { router } = renderGate('/workspace?tab=models');

		expect(router.state.location.pathname).toBe('/workspace');
		expect(screen.getByText('protected content')).toBeInTheDocument();
	});

	it('navigates to /auth with the current path once the session resolves to anonymous', async () => {
		useAuthStore.setState({ status: 'anonymous' });

		const { router } = renderGate('/workspace?tab=models');

		expect(await screen.findByText('auth page')).toBeInTheDocument();
		expect(router.state.location.pathname).toBe('/auth');
		expect(router.state.location.search).toBe('?redirect=%2Fworkspace%3Ftab%3Dmodels');
	});

	it('does not redirect once authenticated', () => {
		useAuthStore.setState({ status: 'authenticated' });

		const { router } = renderGate('/workspace');

		expect(router.state.location.pathname).toBe('/workspace');
		expect(screen.getByText('protected content')).toBeInTheDocument();
	});
});
