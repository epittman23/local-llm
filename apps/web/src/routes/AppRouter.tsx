import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AdminLayout } from '@/routes/admin/AdminLayout';
import { AnalyticsRedirect, SettingsRedirect } from '@/routes/admin/SettingsRedirects';
import { EvaluationsPage } from '@/routes/admin/evaluations/EvaluationsPage';
import { FunctionCreatePage, FunctionEditPage } from '@/routes/admin/functions/FunctionPages';
import { FunctionsPage } from '@/routes/admin/functions/FunctionsPage';
import { UsersPage } from '@/routes/admin/users/UsersPage';
import { AnswersPage } from '@/routes/benchmarks/AnswersPage';
import { BenchmarksLayout } from '@/routes/benchmarks/BenchmarksLayout';
import { ComparePage } from '@/routes/benchmarks/ComparePage';
import { LivePage } from '@/routes/benchmarks/LivePage';
import { ReportPage } from '@/routes/benchmarks/ReportPage';
import { ServePage } from '@/routes/benchmarks/ServePage';
import { TestsPage } from '@/routes/benchmarks/TestsPage';
import { TunePage } from '@/routes/benchmarks/TunePage';
import { LegacyFallback } from '@/routes/LegacyFallback';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { AuthPage } from '@/routes/public/AuthPage';
import { ErrorPage } from '@/routes/public/ErrorPage';
import { SharedChatPage } from '@/routes/public/SharedChatPage';
import { WatchPage } from '@/routes/public/WatchPage';
import { routePaths } from '@/routes/routePaths';
import { PromptEditPage } from '@/routes/workspace/prompts/PromptEditPage';
import { PromptsPage } from '@/routes/workspace/prompts/PromptsPage';
import { SkillCreatePage, SkillEditPage } from '@/routes/workspace/skills/SkillPages';
import { SkillsPage } from '@/routes/workspace/skills/SkillsPage';
import { ToolCreatePage, ToolEditPage } from '@/routes/workspace/tools/ToolPages';
import { ToolsPage } from '@/routes/workspace/tools/ToolsPage';
import { KnowledgeBasePage } from '@/routes/workspace/knowledge/KnowledgeBasePage';
import { KnowledgePage } from '@/routes/workspace/knowledge/KnowledgePage';
import { ModelCreatePage, ModelEditPage } from '@/routes/workspace/models/ModelPages';
import { ModelsPage } from '@/routes/workspace/models/ModelsPage';
import { WorkspaceIndexRedirect } from '@/routes/workspace/WorkspaceIndexRedirect';
import { WorkspaceLayout } from '@/routes/workspace/WorkspaceLayout';

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
			// LegacyFallback bounces to is actually public on the Svelte side.
			// Phase 6's four public/static pages below are the concrete case
			// that comment predicted: they're top-level siblings of this route,
			// not children of it, for exactly the same reason.
			element: <AppShell />,
			children: [
				{ path: routePaths.home, element: <PlaceholderPage title="Chat" phase="Phase 10" /> },
				{
					path: routePaths.workspace,
					element: <WorkspaceLayout />,
					children: [
						{ index: true, element: <WorkspaceIndexRedirect /> },
						{ path: 'models', element: <ModelsPage /> },
						{ path: 'models/create', element: <ModelCreatePage /> },
						{ path: 'models/edit', element: <ModelEditPage /> },
						{ path: 'knowledge', element: <KnowledgePage /> },
						{ path: 'knowledge/create', element: <KnowledgePage showCreateOnMount /> },
						{ path: 'knowledge/:id', element: <KnowledgeBasePage /> },
						{ path: 'prompts', element: <PromptsPage /> },
						{ path: 'prompts/create', element: <PromptsPage showCreateOnMount /> },
						{ path: 'prompts/:id', element: <PromptEditPage /> },
						{ path: 'skills', element: <SkillsPage /> },
						{ path: 'skills/create', element: <SkillCreatePage /> },
						{ path: 'skills/edit', element: <SkillEditPage /> },
						{ path: 'tools', element: <ToolsPage /> },
						{ path: 'tools/create', element: <ToolCreatePage /> },
						{ path: 'tools/edit', element: <ToolEditPage /> },
						// (app)/workspace/functions/create/+page.svelte is only a redirect to the
						// admin surface; /admin/functions/create is a real route as of Phase 8.
						{ path: 'functions/create', element: <Navigate to="/admin/functions/create" replace /> }
					]
				},
				{
					path: routePaths.admin,
					element: <AdminLayout />,
					children: [
						// Bare /admin and /admin/users are redirect pages in the Svelte app
						// (onMount goto); ported as index routes.
						{ index: true, element: <Navigate to={routePaths.adminUsers} replace /> },
						{ path: 'users', element: <Navigate to={routePaths.adminUsersOverview} replace /> },
						{ path: 'users/:tab', element: <UsersPage /> },
						{ path: 'evaluations', element: <Navigate to={routePaths.adminEvaluationsLeaderboard} replace /> },
						{ path: 'evaluations/:tab', element: <EvaluationsPage /> },
						{ path: 'settings', element: <SettingsRedirect /> },
						{ path: 'settings/:tab', element: <SettingsRedirect /> },
						{ path: 'analytics', element: <AnalyticsRedirect /> },
						{ path: 'analytics/:tab', element: <AnalyticsRedirect /> },
						{ path: 'functions', element: <FunctionsPage /> },
						{ path: 'functions/create', element: <FunctionCreatePage /> },
						{ path: 'functions/edit', element: <FunctionEditPage /> }
					]
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
						{ path: routePaths.benchmarksTests, element: <TestsPage /> },
						{ path: routePaths.benchmarksCompare, element: <ComparePage /> },
						{ path: routePaths.benchmarksAnswers, element: <AnswersPage /> },
						{ path: routePaths.benchmarksReport, element: <ReportPage /> },
						{ path: routePaths.benchmarksTune, element: <TunePage /> }
					]
				}
			]
		},
		// Phase 6 (docs/migration-plan.md): the four public/static pages. None
		// of these should ever require a session -- /auth is precisely where
		// an anonymous visitor is sent, and /error, /watch, and a shared-chat
		// link all need to render before or without one.
		{ path: routePaths.auth, element: <AuthPage /> },
		{ path: routePaths.error, element: <ErrorPage /> },
		{ path: routePaths.watch, element: <WatchPage /> },
		{ path: routePaths.share, element: <SharedChatPage /> },
		{ path: '*', element: <LegacyFallback /> }
	],
	// Astro's own base path: unprefixed in dev (`make astro`), "/next" once
	// built and mounted in main.py (see astro.config.mjs's own comment).
	{ basename: import.meta.env.BASE_URL }
);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
