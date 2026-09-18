import type { MiddlewareHandler } from 'astro';

// Gives `astro dev` (and `astro preview`) the same SPA-fallback behavior
// production already gets from main.py's SPAStaticFiles mount: a path with
// no matching static route (e.g. a direct load or refresh on /workspace)
// re-renders the root shell instead of 404ing, so react-router's own client-
// side routing can take over once React mounts. Found and verified directly:
// src/pages/[...path].astro's getStaticPaths alone does NOT do this --
// output: 'static' enumerates dev-server routes the same way `astro build`
// does, so an unmatched path 404s before this middleware's rewrite ever had
// a chance to matter, unless the rewrite happens here, in middleware, which
// astro confirms runs on every request regardless of whether routing found
// a match.
export const onRequest: MiddlewareHandler = async (context, next) => {
	const response = await next();

	if (response.status === 404 && !context.url.pathname.startsWith('/_astro/')) {
		return context.rewrite('/');
	}

	return response;
};
