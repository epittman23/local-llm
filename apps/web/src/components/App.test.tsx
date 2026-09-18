import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from './App';

describe('App', () => {
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
