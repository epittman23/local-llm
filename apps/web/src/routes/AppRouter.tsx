import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { LegacyFallback } from '@/routes/LegacyFallback';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { routePaths } from '@/routes/routePaths';

const router = createBrowserRouter(
	[
		{
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
				},
				{ path: '*', element: <LegacyFallback /> }
			]
		}
	],
	// Astro's own base path: unprefixed in dev (`make astro`), "/next" once
	// built and mounted in main.py (see astro.config.mjs's own comment).
	{ basename: import.meta.env.BASE_URL }
);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
