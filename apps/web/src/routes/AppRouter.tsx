import { useEffect } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { removeStaticBootSplash } from '@/components/layout/BootSplash';
import { RootLayout } from '@/components/layout/RootLayout';
import type { RouteHandle } from '@/lib/ui/pageTitle';
import { AdminLayout } from '@/routes/admin/AdminLayout';
import { EvaluationsPage } from '@/routes/admin/evaluations/EvaluationsPage';
import { FunctionCreatePage, FunctionEditPage } from '@/routes/admin/functions/FunctionPages';
import { FunctionsPage } from '@/routes/admin/functions/FunctionsPage';
import { AnalyticsRedirect, SettingsRedirect } from '@/routes/admin/SettingsRedirects';
import { UsersPage } from '@/routes/admin/users/UsersPage';
import { AutomationPage } from '@/routes/automations/AutomationPage';
import { AutomationsPage } from '@/routes/automations/AutomationsPage';
import { AnswersPage } from '@/routes/benchmarks/AnswersPage';
import { BenchmarksLayout } from '@/routes/benchmarks/BenchmarksLayout';
import { ComparePage } from '@/routes/benchmarks/ComparePage';
import { LivePage } from '@/routes/benchmarks/LivePage';
import { PrescreenPage } from '@/routes/benchmarks/PrescreenPage';
import { ReportPage } from '@/routes/benchmarks/ReportPage';
import { ServePage } from '@/routes/benchmarks/ServePage';
import { TestsPage } from '@/routes/benchmarks/TestsPage';
import { TunePage } from '@/routes/benchmarks/TunePage';
import { CalendarPage } from '@/routes/calendar/CalendarPage';
import { ChannelPage } from '@/routes/channels/ChannelPage';
import { ChatPage } from '@/routes/chat/ChatPage';
import { HomePage } from '@/routes/home/HomePage';
import { NotFound } from '@/routes/NotFound';
import { NoteEditorPage } from '@/routes/notes/NoteEditorPage';
import { NewNotePage, NotesPage } from '@/routes/notes/NotesPage';
import {
	PlaygroundChat,
	PlaygroundCompletions,
	PlaygroundImages,
	PlaygroundLayout
} from '@/routes/playground/PlaygroundPages';
import { AuthPage } from '@/routes/public/AuthPage';
import { ErrorPage } from '@/routes/public/ErrorPage';
import { SharedChatPage } from '@/routes/public/SharedChatPage';
import { WatchPage } from '@/routes/public/WatchPage';
import { routePaths } from '@/routes/routePaths';
import { UiStandardPage } from '@/routes/ui/UiStandardPage';
import { KnowledgeBasePage } from '@/routes/workspace/knowledge/KnowledgeBasePage';
import { KnowledgePage } from '@/routes/workspace/knowledge/KnowledgePage';
import { ModelCreatePage, ModelEditPage } from '@/routes/workspace/models/ModelPages';
import { ModelsPage } from '@/routes/workspace/models/ModelsPage';
import { PromptEditPage } from '@/routes/workspace/prompts/PromptEditPage';
import { PromptsPage } from '@/routes/workspace/prompts/PromptsPage';
import { SkillCreatePage, SkillEditPage } from '@/routes/workspace/skills/SkillPages';
import { SkillsPage } from '@/routes/workspace/skills/SkillsPage';
import { ToolCreatePage, ToolEditPage } from '@/routes/workspace/tools/ToolPages';
import { ToolsPage } from '@/routes/workspace/tools/ToolsPage';
import { WorkspaceIndexRedirect } from '@/routes/workspace/WorkspaceIndexRedirect';
import { WorkspaceLayout } from '@/routes/workspace/WorkspaceLayout';

// Each route's page name for the tab title (LAY-5) and where its h1 comes from
// (A11Y-3): `layout` when its section layout's page header holds it, `page`
// when the page draws its own (lib/ui/pageTitle.ts).
const layout = (title: string): RouteHandle => ({ title, heading: 'layout' });
const page = (title: string): RouteHandle => ({ title, heading: 'page' });

const router = createBrowserRouter(
	[
		{
			// Every route, public ones included: the tab title from each route's
			// `handle` and the system theme listener.
			element: <RootLayout />,
			children: [
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
								{ path: routePaths.home, element: null, handle: page('New chat') },
								{ path: 'c/:id', element: null, handle: { title: 'Chat', heading: 'sr' } },
								{ path: `${routePaths.folders}/:folderId`, element: null, handle: { title: 'Folder', heading: 'sr' } }
							]
						},
						{
							path: routePaths.workspace,
							element: <WorkspaceLayout />,
							children: [
								{ index: true, element: <WorkspaceIndexRedirect />, handle: layout('Workspace') },
								{ path: 'models', element: <ModelsPage />, handle: layout('Models') },
								{ path: 'models/create', element: <ModelCreatePage />, handle: layout('New model') },
								{ path: 'models/edit', element: <ModelEditPage />, handle: layout('Edit model') },
								{ path: 'knowledge', element: <KnowledgePage />, handle: layout('Knowledge') },
								{
									path: 'knowledge/create',
									element: <KnowledgePage showCreateOnMount />,
									handle: layout('New knowledge base')
								},
								{ path: 'knowledge/:id', element: <KnowledgeBasePage />, handle: layout('Knowledge base') },
								{ path: 'prompts', element: <PromptsPage />, handle: layout('Prompts') },
								{ path: 'prompts/create', element: <PromptsPage showCreateOnMount />, handle: layout('New prompt') },
								{ path: 'prompts/:id', element: <PromptEditPage />, handle: layout('Edit prompt') },
								{ path: 'skills', element: <SkillsPage />, handle: layout('Skills') },
								{ path: 'skills/create', element: <SkillCreatePage />, handle: layout('New skill') },
								{ path: 'skills/edit', element: <SkillEditPage />, handle: layout('Edit skill') },
								{ path: 'tools', element: <ToolsPage />, handle: layout('Tools') },
								{ path: 'tools/create', element: <ToolCreatePage />, handle: layout('New tool') },
								{ path: 'tools/edit', element: <ToolEditPage />, handle: layout('Edit tool') },
								// (app)/workspace/functions/create/+page.svelte is only a redirect to the
								// admin surface; /admin/functions/create is a real route as of Phase 8.
								{
									path: 'functions/create',
									element: <Navigate to="/admin/functions/create" replace />,
									handle: layout('New function')
								}
							]
						},
						{
							path: routePaths.admin,
							element: <AdminLayout />,
							children: [
								// Bare /admin and /admin/users are redirect pages in the Svelte app
								// (onMount goto); ported as index routes.
								{ index: true, element: <Navigate to={routePaths.adminUsers} replace />, handle: layout('Users') },
								{
									path: 'users',
									element: <Navigate to={routePaths.adminUsersOverview} replace />,
									handle: layout('Users')
								},
								{ path: 'users/:tab', element: <UsersPage />, handle: layout('Users') },
								{
									path: 'evaluations',
									element: <Navigate to={routePaths.adminEvaluationsLeaderboard} replace />,
									handle: layout('Evaluations')
								},
								{ path: 'evaluations/:tab', element: <EvaluationsPage />, handle: layout('Evaluations') },
								{ path: 'settings', element: <SettingsRedirect />, handle: layout('Settings') },
								{ path: 'settings/:tab', element: <SettingsRedirect />, handle: layout('Settings') },
								{ path: 'analytics', element: <AnalyticsRedirect />, handle: layout('Analytics') },
								{ path: 'analytics/:tab', element: <AnalyticsRedirect />, handle: layout('Analytics') },
								{ path: 'functions', element: <FunctionsPage />, handle: layout('Functions') },
								{ path: 'functions/create', element: <FunctionCreatePage />, handle: layout('New function') },
								{ path: 'functions/edit', element: <FunctionEditPage />, handle: layout('Edit function') }
							]
						},
						{ path: routePaths.automations, element: <AutomationsPage />, handle: page('Automations') },
						{ path: `${routePaths.automations}/:id`, element: <AutomationPage />, handle: page('Automation') },
						{
							path: routePaths.playground,
							element: <PlaygroundLayout />,
							children: [
								{ index: true, element: <PlaygroundChat />, handle: layout('Playground') },
								{ path: 'completions', element: <PlaygroundCompletions />, handle: layout('Completions') },
								{ path: 'images', element: <PlaygroundImages />, handle: layout('Images') }
							]
						},
						{ path: `${routePaths.channels}/:id`, element: <ChannelPage />, handle: page('Channel') },
						{ path: routePaths.homePage, element: <HomePage />, handle: page('Home') },
						{ path: routePaths.notes, element: <NotesPage />, handle: page('Notes') },
						{ path: `${routePaths.notes}/new`, element: <NewNotePage />, handle: page('New note') },
						{ path: `${routePaths.notes}/:id`, element: <NoteEditorPage />, handle: page('Note') },
						{
							path: routePaths.calendar,
							element: <CalendarPage />,
							handle: page('Calendar')
						},
						{
							path: routePaths.benchmarks,
							element: <BenchmarksLayout />,
							children: [
								// Bare /benchmarks redirects to /serve, matching the Svelte app's
								// own (app)/benchmarks/+page.svelte (an onMount goto, ported here
								// as an index route's own element instead).
								{ index: true, element: <Navigate to={routePaths.benchmarksServe} replace />, handle: layout('Serve') },
								{ path: routePaths.benchmarksServe, element: <ServePage />, handle: layout('Serve') },
								{ path: routePaths.benchmarksLive, element: <LivePage />, handle: layout('Live') },
								{ path: routePaths.benchmarksTests, element: <TestsPage />, handle: layout('Tests') },
								{ path: routePaths.benchmarksCompare, element: <ComparePage />, handle: layout('Compare') },
								{ path: routePaths.benchmarksAnswers, element: <AnswersPage />, handle: layout('Answers') },
								{ path: routePaths.benchmarksReport, element: <ReportPage />, handle: layout('Report') },
								{ path: routePaths.benchmarksTune, element: <TunePage />, handle: layout('Tune') },
								{ path: routePaths.benchmarksPrescreen, element: <PrescreenPage />, handle: layout('Pre-screen') }
							]
						}
					]
				},
				// Phase 6 (docs/history/migration-plan.md): the four public/static pages. None
				// of these should ever require a session -- /auth is precisely where
				// an anonymous visitor is sent, and /error, /watch, and a shared-chat
				// link all need to render before or without one.
				{ path: routePaths.auth, element: <AuthPage />, handle: page('Sign in') },
				{ path: routePaths.error, element: <ErrorPage />, handle: page("Can't reach the server") },
				{ path: routePaths.watch, element: <WatchPage />, handle: page('Opening a video') },
				{ path: routePaths.share, element: <SharedChatPage />, handle: page('Shared chat') },
				{ path: routePaths.uiStandard, element: <UiStandardPage />, handle: page('Interface standard') },
				{ path: '*', element: <NotFound />, handle: page('Page not found') }
			]
		}
	],
	// Astro's own base path (`/`; main.py mounts the build at the root).
	{ basename: import.meta.env.BASE_URL }
);

export function AppRouter() {
	// Base.astro's static boot splash comes down once React has drawn. Here,
	// outside the routes, so a route that throws on its first render still
	// shows react-router's error page instead of a splash over it.
	useEffect(removeStaticBootSplash, []);
	return <RouterProvider router={router} />;
}
