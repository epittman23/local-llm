// The single list of paths this app owns as real React routes (see AppRouter.tsx).
// A nav item (src/components/layout/Sidebar.tsx) links here with react-router's
// <Link>; a nav item for anything NOT in this list is a plain <a> to the
// SvelteKit app instead, since react-router has no route to hand it to.
export const routePaths = {
	home: '/',
	workspace: '/workspace',
	notes: '/notes',
	calendar: '/calendar',
	benchmarks: '/benchmarks',
	benchmarksServe: '/benchmarks/serve',
	benchmarksLive: '/benchmarks/live',
	benchmarksTests: '/benchmarks/tests',
	benchmarksCompare: '/benchmarks/compare',
	benchmarksAnswers: '/benchmarks/answers',
	benchmarksReport: '/benchmarks/report',
	benchmarksTune: '/benchmarks/tune'
} as const;
