import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useWebUIName } from '@/lib/stores/configStore';
import { installSystemThemeListener } from '@/lib/theme';
import { composeTitle, useRouteTitle } from '@/lib/ui/pageTitle';

/**
 * The root of every route, public ones included (AppRouter.tsx). It owns what
 * every page shares regardless of the session:
 *
 * - the tab title, `<Page> · local-llm` (LAY-5, WRD-3), from the deepest route's
 *   `handle.title` or the page's own dynamic piece (lib/ui/pageTitle.ts);
 * - "System" theme following the OS while the page is open (COL-6).
 *
 * Base.astro's static boot splash is taken down by AppRouter, outside the
 * routes, so it also goes when a route fails to render.
 */
export function RootLayout() {
	const { page } = useRouteTitle();
	const name = useWebUIName();

	useEffect(() => {
		document.title = composeTitle(page, name);
	}, [page, name]);

	useEffect(installSystemThemeListener, []);

	return <Outlet />;
}
