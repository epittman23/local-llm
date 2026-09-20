// The single list of paths this app owns as real React routes (see AppRouter.tsx).
// A nav item (src/components/layout/Sidebar.tsx) links here with react-router's
// <Link>; a nav item for anything NOT in this list is a plain <a> to the
// SvelteKit app instead, since react-router has no route to hand it to.
export const routePaths = {
	home: '/',
	workspace: '/workspace',
	workspaceModels: '/workspace/models',
	workspaceModelsCreate: '/workspace/models/create',
	workspaceModelsEdit: '/workspace/models/edit',
	workspaceKnowledge: '/workspace/knowledge',
	workspacePrompts: '/workspace/prompts',
	workspaceSkills: '/workspace/skills',
	workspaceSkillsCreate: '/workspace/skills/create',
	workspaceSkillsEdit: '/workspace/skills/edit',
	workspaceTools: '/workspace/tools',
	workspaceToolsCreate: '/workspace/tools/create',
	workspaceToolsEdit: '/workspace/tools/edit',
	admin: '/admin',
	adminUsers: '/admin/users',
	adminUsersOverview: '/admin/users/overview',
	adminUsersGroups: '/admin/users/groups',
	adminEvaluations: '/admin/evaluations',
	adminEvaluationsLeaderboard: '/admin/evaluations/leaderboard',
	adminEvaluationsFeedback: '/admin/evaluations/feedback',
	adminFunctions: '/admin/functions',
	adminFunctionsCreate: '/admin/functions/create',
	adminFunctionsEdit: '/admin/functions/edit',
	adminSettings: '/admin/settings',
	notes: '/notes',
	calendar: '/calendar',
	benchmarks: '/benchmarks',
	benchmarksServe: '/benchmarks/serve',
	benchmarksLive: '/benchmarks/live',
	benchmarksTests: '/benchmarks/tests',
	benchmarksCompare: '/benchmarks/compare',
	benchmarksAnswers: '/benchmarks/answers',
	benchmarksReport: '/benchmarks/report',
	benchmarksTune: '/benchmarks/tune',
	// Phase 6's four public/static surfaces. Unlike everything above, these
	// are NOT children of AppShell in AppRouter.tsx -- they're the one place
	// an unauthenticated visitor is supposed to land, so useAuthGate must not
	// wrap them the way it wraps every authenticated route.
	auth: '/auth',
	error: '/error',
	watch: '/watch',
	share: '/s/:id'
} as const;

/** Builds a concrete `/s/<id>` path from `routePaths.share`'s `:id` pattern. */
export const sharePath = (id: string) => `/s/${id}`;

/**
 * An absolute path for a plain `<a>` (e.g. `target="_blank"`), which react-router
 * does not rewrite: prefixes the app's base (`/next` in a build, nothing in dev).
 * Use `<Link>` for in-app navigation; this is only for links that leave the SPA
 * shell into a new tab.
 */
export const appHref = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;
