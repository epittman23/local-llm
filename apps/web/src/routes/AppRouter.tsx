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
import { AutomationPage } from '@/routes/automations/AutomationPage';
import { AutomationsPage } from '@/routes/automations/AutomationsPage';
import { CalendarPage } from '@/routes/calendar/CalendarPage';
import { ChannelPage } from '@/routes/channels/ChannelPage';
import { ChatPage } from '@/routes/chat/ChatPage';
import { HomePage } from '@/routes/home/HomePage';
import { NotFound } from '@/routes/NotFound';
import { NoteEditorPage } from '@/routes/notes/NoteEditorPage';
import { NewNotePage, NotesPage } from '@/routes/notes/NotesPage';
import { PlaygroundChat, PlaygroundCompletions, PlaygroundImages, PlaygroundLayout } from '@/routes/playground/PlaygroundPages';
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
			// Only the real React routes live under AppShell and its route gate.
			// NotFound (the catch-all below) is outside it: a 404 needs no
			// session. Phase 6's four
			// public pages are top-level siblings for the same reason.
			element: <AppShell />,
			children: [
				{
					// One element for the three chat paths, so a new chat keeps its
					// state when the server names it and the URL becomes /c/<id>.
					element: <ChatPage />,
					children: [
						{ path: routePaths.home, element: null },
						{ path: 'c/:id', element: null },
						{ path: `${routePaths.folders}/:folderId`, element: null }
					]
				},
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
				{ path: routePaths.automations, element: <AutomationsPage /> },
				{ path: `${routePaths.automations}/:id`, element: <AutomationPage /> },
				{
					path: routePaths.playground,
					element: <PlaygroundLayout />,
					children: [
						{ index: true, element: <PlaygroundChat /> },
						{ path: 'completions', element: <PlaygroundCompletions /> },
						{ path: 'images', element: <PlaygroundImages /> }
					]
				},
				{ path: `${routePaths.channels}/:id`, element: <ChannelPage /> },
				{ path: routePaths.homePage, element: <HomePage /> },
				{ path: routePaths.notes, element: <NotesPage /> },
				{ path: `${routePaths.notes}/new`, element: <NewNotePage /> },
				{ path: `${routePaths.notes}/:id`, element: <NoteEditorPage /> },
				{
					path: routePaths.calendar,
					element: <CalendarPage />
				},
				{
					path: routePaths.benchmarks,
					element: <BenchmarksLayout />,
					children: [
						// Bare /benchmarks redirects to /serve, matching the Svelte app's
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
		{ path: '*', element: <NotFound /> }
	],
	// Astro's own base path (`/`; main.py mounts the build at the root).
	{ basename: import.meta.env.BASE_URL }
);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
