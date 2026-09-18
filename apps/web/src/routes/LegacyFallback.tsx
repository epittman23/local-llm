import { useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * Rendered by AppRouter's catch-all ("*") route: whatever path the user
 * landed on isn't one of routePaths' real React routes. Most of those paths
 * are real SvelteKit pages this migration hasn't ported yet (Phases 5-10 own
 * that one surface at a time -- see docs/migration-plan.md's Status board),
 * not actually missing -- so the default behavior a "not found" 404 implies
 * would be wrong for nearly every path this ever fires on.
 *
 * TODO(human): implement resolveLegacyFallback. It's called once per mount
 * with the unmatched pathname (e.g. "/c/abc123", "/admin/users",
 * "/benchmarks/tune") and decides what actually happens next.
 *
 * Some options, not exhaustive:
 *  - Always send it to the SvelteKit app at the same path (a full
 *    `window.location` navigation, not a react-router one -- react-router
 *    can't render a page it doesn't own). Simplest, and correct today since
 *    every real path IS still Svelte-owned except routePaths' own list.
 *  - Keep an explicit allowlist or pattern set of paths known to have NO
 *    Svelte-side counterpart (typos, truly removed routes) and show an
 *    in-app "not found" for those, falling back to Svelte for everything
 *    else. More correct long-term, since by Phase 11 most paths will be
 *    React-owned and an unconditional bounce back to a deleted Svelte app
 *    would be wrong the other direction.
 *  - Something else -- e.g. probing whether the path 404s in Svelte too
 *    before bouncing, to avoid a redirect loop on a genuinely dead link.
 *
 * Whatever this becomes also has to consider: an infinite bounce is possible
 * if Svelte's own router ever forwards an unrecognized path back to `/next`
 * (worth checking apps/openwebui/src/routes/+layout.svelte's 404 handling,
 * if any, before assuming a one-way redirect is safe).
 */
function resolveLegacyFallback(pathname: string): void {
	// TODO(human): implement -- see the block comment above.
}

export function LegacyFallback() {
	const location = useLocation();

	useEffect(() => {
		resolveLegacyFallback(location.pathname + location.search + location.hash);
	}, [location.pathname, location.search, location.hash]);

	return (
		<div className="flex flex-1 items-center justify-center p-8">
			<p className="text-muted-foreground text-sm">Loading…</p>
		</div>
	);
}
