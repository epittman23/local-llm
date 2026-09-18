import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

const fakeUser = {
	id: 'test-user',
	email: 'test@example.com',
	name: 'Test User',
	role: 'user',
	profile_image_url: '',
	expires_at: Math.floor(Date.now() / 1000) + 3600
};

describe('App', () => {
	beforeEach(() => {
		// The route gate (lib/auth/useAuthGate.ts, ported from apps/openwebui's
		// own (app)/+layout.svelte) redirects to /auth for any status other than
		// 'authenticated' -- so exercising the shell at all needs a session.
		// localStorage.token is what lib/auth/session.ts's initAuth() bootstraps
		// from; mocking fetch stands in for the real getSessionUser() call it
		// makes with that token, since there's no backend in this test.
		localStorage.setItem('token', 'test-token');
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => fakeUser
			})
		);
	});

	afterEach(() => {
		localStorage.clear();
		vi.unstubAllGlobals();
	});

	it('renders the app shell and the home route', async () => {
		render(<App />);

		// PlaceholderPage's own heading for routePaths.home (see routes/AppRouter.tsx) --
		// confirms the provider stack (i18n/query/auth/socket) and the router all
		// mounted without throwing, not just that some JSX came back.
		expect(await screen.findByRole('heading', { name: 'Chat' })).toBeInTheDocument();

		// The sidebar defaults closed (mirrors apps/openwebui/src/lib/components/
		// layout/Sidebar.svelte's own localStorage.sidebar default) and is not
		// rendered at all until opened -- see AppShell.tsx's own comment on why
		// it's unmounted rather than just visually collapsed.
		fireEvent.click(screen.getByRole('button', { name: /open sidebar/i }));
		expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
	});
});
