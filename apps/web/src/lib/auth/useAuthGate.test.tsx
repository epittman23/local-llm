import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useAuthGate } from './useAuthGate';

// A tiny host so useAuthGate runs inside real router context -- matching how
// AppShell.tsx actually calls it, and how AppRouter.tsx builds its router
// (createBrowserRouter, the data router), not the older declarative
// <MemoryRouter> component (which double-mounts its children on init and
// would make every assertion below count two identical calls instead of one).
function GateProbe() {
	useAuthGate();
	return null;
}

function renderGate(initialPath: string) {
	const router = createMemoryRouter([{ path: '*', element: <GateProbe /> }], {
		initialEntries: [initialPath]
	});
	return render(<RouterProvider router={router} />);
}

describe('useAuthGate', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		useAuthStore.setState({ status: 'pending', token: null, user: null });
	});

	it('does nothing while the session bootstrap is still pending', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		useAuthStore.setState({ status: 'pending' });

		renderGate('/workspace?tab=models');

		expect(assign).not.toHaveBeenCalled();
	});

	it('redirects to /auth with the current path once the session resolves to anonymous', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		useAuthStore.setState({ status: 'anonymous' });

		renderGate('/workspace?tab=models');

		expect(assign).toHaveBeenCalledExactlyOnceWith('/auth?redirect=%2Fworkspace%3Ftab%3Dmodels');
	});

	it('does not redirect once authenticated', () => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		useAuthStore.setState({ status: 'authenticated' });

		renderGate('/workspace');

		expect(assign).not.toHaveBeenCalled();
	});
});
