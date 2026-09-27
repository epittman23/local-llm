import { Link, useLocation } from 'react-router';

/**
 * AppRouter's catch-all ("*") route: the path is not one of this app's routes.
 *
 * Until Phase 9 this bounced every such path to the same path with a full
 * `window.location` navigation, on the theory that it was a Svelte page not
 * yet ported. That stopped being right twice over: on the dev server (`:5174`)
 * the same path is answered by this app again, so the bounce looped forever
 * (START.md measured 14 reloads in 4 s); and once most of the app is React, an
 * unmatched path is far more likely to be a typo than a Svelte page.
 *
 * Policy now: never navigate on its own. A path that belongs to a surface
 * still owned by the Svelte app (`svelteOnlySurface`) says so and links to it
 * -- the Svelte dev server (`:5173`) in development, the same path in a build,
 * where the Svelte app is served at the root and this one under `/next`.
 * Anything else is this app's own 404.
 */

/**
 * Path prefixes still owned by the Svelte app, and the surface's name. Empty
 * since Phase 10 ported the chat: every surface is in this app now, so the
 * catch-all is simply the 404. Kept (not deleted) until Phase 11 removes the
 * Svelte app, in case a path turns out to have been missed.
 */
const SVELTE_ONLY: [prefix: string, surface: string][] = [];

/** The name of the Svelte-owned surface a path belongs to, or null. */
export function svelteOnlySurface(pathname: string): string | null {
	// A prefix ending in '/' needs something after it; any other matches itself and anything beneath it.
	const matches = (prefix: string) => (prefix.endsWith('/') ? pathname.length > prefix.length && pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`));
	return SVELTE_ONLY.find(([prefix]) => matches(prefix))?.[1] ?? null;
}

/** Where the Svelte version of a path lives: its dev server in development, the same origin in a build. */
export function svelteUrl(path: string, dev = import.meta.env.DEV): string {
	return dev ? `http://localhost:5173${path}` : path;
}

export function LegacyFallback() {
	const location = useLocation();
	const full = location.pathname + location.search + location.hash;
	const surface = svelteOnlySurface(location.pathname);

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
			{surface ? (
				<>
					<h1 className="text-xl font-semibold">{surface} is not in this app yet</h1>
					<p className="text-muted-foreground max-w-sm text-sm">It is still served by the Svelte app while the migration finishes.</p>
					<a className="text-sm underline" href={svelteUrl(full)}>
						Open it there
					</a>
				</>
			) : (
				<>
					<h1 className="text-xl font-semibold">Page not found</h1>
					<p className="text-muted-foreground max-w-sm text-sm">
						Nothing lives at <code>{location.pathname}</code>.
					</p>
					<Link className="text-sm underline" to="/">
						Go home
					</Link>
				</>
			)}
		</div>
	);
}
