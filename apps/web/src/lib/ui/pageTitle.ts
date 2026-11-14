import { type UIMatch, useMatches } from 'react-router';
import { create } from 'zustand';

/**
 * The browser tab's title (docs/guides/ui-standard.md LAY-5): `<Page> · local-llm`.
 *
 * Every route in AppRouter.tsx names its page in its `handle`; RootLayout
 * writes the title from the deepest route that has one. A page whose name is
 * only known once it loads (a chat's title, a note's name) sets a dynamic piece
 * with `useDocumentTitle` (lib/stores/configStore.ts), which wins while that
 * page is mounted.
 */
export const TITLE_SEPARATOR = ' · ';

/**
 * Where a route's `h1` comes from (A11Y-3): its section layout's page header
 * (`layout`), the page itself (`page`), or a visually hidden heading AppShell
 * renders from the page title (`sr`, for pages whose visible heading is not
 * text, like a conversation).
 */
export type RouteHeading = 'layout' | 'page' | 'sr';

export interface RouteHandle {
	title?: string;
	heading?: RouteHeading;
	/**
	 * The page's first row leaves room for the shell's floating menu button
	 * (`--shell-menu-inset`), so on a short phone screen AppShell may fold the
	 * phone bar away (A11Y-5). Pages without it keep the bar.
	 */
	foldsBar?: boolean;
}

/** `<page> · <name>`, or the name alone when there is no page. */
export function composeTitle(page: string | null | undefined, name: string): string {
	const trimmed = page?.trim();
	return trimmed ? `${trimmed}${TITLE_SEPARATOR}${name}` : name;
}

/** The deepest route's title, heading and foldsBar, each taken from the deepest route that sets it. */
export function routeHandle(matches: readonly Pick<UIMatch, 'handle'>[]): RouteHandle {
	const result: RouteHandle = {};
	for (const match of matches) {
		const handle = match.handle as RouteHandle | undefined;
		if (handle?.title !== undefined) result.title = handle.title;
		if (handle?.heading !== undefined) result.heading = handle.heading;
		if (handle?.foldsBar !== undefined) result.foldsBar = handle.foldsBar;
	}
	return result;
}

type DynamicTitleState = {
	/** The page's own name, set by the page that knows it, or null. */
	dynamic: string | null;
	/** Which mounted page set `dynamic`, so another page's cleanup cannot clear it. */
	owner: object | null;
};

export const usePageTitleStore = create<DynamicTitleState>(() => ({ dynamic: null, owner: null }));

/** Sets the dynamic piece for `owner`; null gives it up (see clearDynamicTitle). */
export function setDynamicTitle(owner: object, title: string | null) {
	if (title === null) clearDynamicTitle(owner);
	else usePageTitleStore.setState({ dynamic: title, owner });
}

/** Clears the dynamic piece only if `owner` is still the page that set it. */
export function clearDynamicTitle(owner: object) {
	if (usePageTitleStore.getState().owner === owner) usePageTitleStore.setState({ dynamic: null, owner: null });
}

/** The current page's name (the dynamic piece, else the route's title), where its h1 comes from, and foldsBar. */
export function useRouteTitle(): { page: string | undefined; heading: RouteHeading | undefined; foldsBar: boolean } {
	const handle = routeHandle(useMatches());
	const dynamic = usePageTitleStore((s) => s.dynamic);
	return { page: dynamic ?? handle.title, heading: handle.heading, foldsBar: handle.foldsBar === true };
}
