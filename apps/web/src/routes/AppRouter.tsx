import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { LegacyFallback } from '@/routes/LegacyFallback';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { routePaths } from '@/routes/routePaths';

const router = createBrowserRouter(
	[
		{
			// Only the real React routes live under AppShell -- its route gate
			// (useAuthGate) would otherwise also wrap LegacyFallback below, and an
			// anonymous user hitting a Svelte-owned path should bounce straight to
			// Svelte (which applies its own (app)/+layout.svelte gate there), not
			// get intercepted by *our* gate first. Nesting them would still end
			// up at /auth today since both gates redirect there, but it would be
			// by accident, and it would stop being equivalent the moment a path
			// LegacyFallback bounces to is actually public on the Svelte side
			// (e.g. /s/[id], a share link -- Phase 6).
			element: <AppShell />,
			children: [
				{ path: routePaths.home, element: <PlaceholderPage title="Chat" phase="Phase 10" /> },
				{
					path: routePaths.workspace,
					element: <PlaceholderPage title="Workspace" phase="Phase 7" />
				},
				{ path: routePaths.notes, element: <PlaceholderPage title="Notes" phase="Phase 9" /> },
				{
					path: routePaths.calendar,
					element: <PlaceholderPage title="Calendar" phase="Phase 9" />
				}
			]
		},
		{ path: '*', element: <LegacyFallback /> }
	],
	// Astro's own base path: unprefixed in dev (`make astro`), "/next" once
	// built and mounted in main.py (see astro.config.mjs's own comment).
	{ basename: import.meta.env.BASE_URL }
);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
