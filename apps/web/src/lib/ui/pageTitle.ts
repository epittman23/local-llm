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
	/**
	 * The names `dynamic` covers, oldest first: a dialog that names itself (Settings) over a page that
	 * does too. When the one on top gives its name up, the one under it shows again.
	 */
	below: { owner: object; title: string }[];
};

export const usePageTitleStore = create<DynamicTitleState>(() => ({ dynamic: null, owner: null, below: [] }));

/**
 * Sets the dynamic piece for `owner`; null gives it up (see clearDynamicTitle). A new owner covers the
 * current one; an owner already covered changes its name underneath, so what covers it keeps showing.
 */
export function setDynamicTitle(owner: object, title: string | null) {
	if (title === null) return clearDynamicTitle(owner);
	const { owner: current, dynamic, below = [] } = usePageTitleStore.getState();
	if (current === owner || current === null || dynamic === null) {
		usePageTitleStore.setState({ dynamic: title, owner });
	} else if (below.some((entry) => entry.owner === owner)) {
		usePageTitleStore.setState({
			below: below.map((entry) => (entry.owner === owner ? { owner, title } : entry))
		});
	} else {
		usePageTitleStore.setState({ dynamic: title, owner, below: [...below, { owner: current, title: dynamic }] });
	}
}

/** Gives up `owner`'s piece, if it still has one; the name it covered shows again. */
export function clearDynamicTitle(owner: object) {
	const { owner: current, below = [] } = usePageTitleStore.getState();
	if (current === owner) {
		const next = below.at(-1);
		usePageTitleStore.setState(
			next ? { dynamic: next.title, owner: next.owner, below: below.slice(0, -1) } : { dynamic: null, owner: null }
		);
	} else if (below.some((entry) => entry.owner === owner)) {
		usePageTitleStore.setState({ below: below.filter((entry) => entry.owner !== owner) });
	}
}

/** The current page's name (the dynamic piece, else the route's title), where its h1 comes from, and foldsBar. */
export function useRouteTitle(): { page: string | undefined; heading: RouteHeading | undefined; foldsBar: boolean } {
	const handle = routeHandle(useMatches());
	const dynamic = usePageTitleStore((s) => s.dynamic);
	return { page: dynamic ?? handle.title, heading: handle.heading, foldsBar: handle.foldsBar === true };
}
