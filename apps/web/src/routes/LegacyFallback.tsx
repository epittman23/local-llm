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
 * Policy: unconditional bounce to the SvelteKit app at the same path (a full
 * `window.location` navigation, not a react-router one -- react-router can't
 * render a page it doesn't own). Chosen over the two more conservative
 * options -- an explicit allowlist/pattern set with an in-app 404 for
 * genuinely dead paths, or probing Svelte first before bouncing -- because
 * this migration is still at its very first surface (Phase 4 of 11):
 * routePaths.ts owns four paths total, so "not in routePaths" and "not a
 * real path" are nowhere near the same set yet, and would need constant
 * upkeep to even approximate each other at this stage for no real benefit.
 *
 * Checked, not assumed, that this can't loop: apps/openwebui/src/routes/
 * +error.svelte (SvelteKit's own catch-all) renders a plain "{status}:
 * {message}" in place -- it's a client-side error render, not a redirect --
 * and nothing in the fork's own source references `/next` except main.py's
 * mount itself (grepped for it directly). So a path unmatched by both apps
 * lands on Svelte's bare error page exactly once, not a loop.
 *
 * Revisit this once that stops being true -- concretely, once more paths are
 * React-owned than not (Phase 8+ or so), an unconditional bounce starts being
 * wrong in the other direction: a typo'd or genuinely dead path would bounce
 * to an ever-shrinking Svelte app instead of showing this app's own 404.
 * That's also the point at which whoever moves a surface out of Svelte should
 * check whether Svelte picks up a redirect *toward* `/next` for it (it
 * doesn't today, per the grep above, but that's a fact about today, not a
 * guarantee) -- this policy's safety argument stops holding the moment that
 * changes, and would need re-deriving, not just re-asserting.
 */
// Exported for LegacyFallback.test.tsx -- a mocked window.location.assign is
// the only way to check this without a real backend and SvelteKit build to
// bounce to.
export function resolveLegacyFallback(pathname: string): void {
	window.location.assign(pathname);
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
