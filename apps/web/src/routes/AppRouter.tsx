import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { BenchmarksLayout } from '@/routes/benchmarks/BenchmarksLayout';
import { LivePage } from '@/routes/benchmarks/LivePage';
import { ServePage } from '@/routes/benchmarks/ServePage';
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
				},
				{
					path: routePaths.benchmarks,
					element: <BenchmarksLayout />,
					children: [
						// Bare /benchmarks redirects to /serve, matching apps/openwebui's
						// own (app)/benchmarks/+page.svelte (an onMount goto, ported here
						// as an index route's own element instead).
						{ index: true, element: <Navigate to={routePaths.benchmarksServe} replace /> },
						{ path: routePaths.benchmarksServe, element: <ServePage /> },
						{ path: routePaths.benchmarksLive, element: <LivePage /> },
						{
							path: routePaths.benchmarksTests,
							element: <PlaceholderPage title="Tests" phase="Phase 5 (later)" />
						},
						{
							path: routePaths.benchmarksCompare,
							element: <PlaceholderPage title="Compare" phase="Phase 5 (later)" />
						},
						{
							path: routePaths.benchmarksAnswers,
							element: <PlaceholderPage title="Answers" phase="Phase 5 (later)" />
						},
						{
							path: routePaths.benchmarksReport,
							element: <PlaceholderPage title="Report" phase="Phase 5 (later)" />
						},
						{
							path: routePaths.benchmarksTune,
							element: <PlaceholderPage title="Tune" phase="Phase 5 (later)" />
						}
					]
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
