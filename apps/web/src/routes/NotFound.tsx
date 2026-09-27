import { Link, useLocation } from 'react-router';

/**
 * AppRouter's catch-all ("*") route: the path is not one of this app's routes.
 * It never navigates on its own. Until Phase 11 this was `LegacyFallback`,
 * which bounced unported paths to the SvelteKit app; on the dev server that
 * bounce landed back here and looped, and the Svelte app is gone now anyway.
 */
export function NotFound() {
	const location = useLocation();
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
			<h1 className="text-xl font-semibold">Page not found</h1>
			<p className="text-muted-foreground max-w-sm text-sm">
				Nothing lives at <code>{location.pathname}</code>.
			</p>
			<Link className="text-sm underline" to="/">
				Go home
			</Link>
		</div>
	);
}
