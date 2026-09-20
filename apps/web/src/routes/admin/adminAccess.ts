import type { SessionUser } from '@/lib/stores/authStore';
import type { BackendConfig } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

export type AdminGate = { allowed: true } | { allowed: false; redirectTo: string };

/**
 * The redirect rule from admin/+layout.svelte's onMount: a non-admin goes home;
 * an admin who opens /admin/functions/** while plugins are off goes to /admin
 * (which then lands on Users). The Functions *tab* is hidden under the same
 * condition, so the two stay in step.
 */
export function adminGate(user: SessionUser | null, config: BackendConfig | null, pathname: string): AdminGate {
	if (user?.role !== 'admin') return { allowed: false, redirectTo: routePaths.home };
	if (!config?.features?.enable_plugins && isFunctionsPath(pathname)) {
		return { allowed: false, redirectTo: routePaths.admin };
	}
	return { allowed: true };
}

// `includes`, as the Svelte layout does, not a prefix test: the app may be
// mounted under a base path (/next) and `pathname` from react-router is
// already base-relative, but matching the original keeps behaviour identical.
export const isFunctionsPath = (pathname: string) => pathname.includes('/admin/functions');

export type AdminSection = 'users' | 'evaluations' | 'functions' | 'settings';

/** Which top-level tab a path belongs to (`pathname.includes` in the layout). */
export function adminSectionOfPath(pathname: string): AdminSection | null {
	if (pathname.includes('/admin/users')) return 'users';
	if (pathname.includes('/admin/evaluations')) return 'evaluations';
	if (pathname.includes('/admin/functions')) return 'functions';
	if (pathname.includes('/admin/settings')) return 'settings';
	return null;
}

/**
 * `/admin/users/groups` -> `groups`. Anything that is not one of `tabs` falls
 * back to the first, which is what the Svelte tab wrappers do with the last
 * path segment (`['overview','groups'].includes(tab) ? tab : 'overview'`).
 */
export function tabFromPath<T extends string>(pathname: string, tabs: readonly T[]): T {
	const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
	return (tabs as readonly string[]).includes(last) ? (last as T) : tabs[0];
}

/**
 * Where `/admin/settings[/<tab>]` goes: the Settings *modal*, opened by a
 * `settings=admin:<tab>` query param on the chat page. Other query params ride
 * along, as in the two Svelte redirect pages.
 */
export function settingsRedirectPath(tab: string | undefined, search: string): string {
	const params = new URLSearchParams(search);
	params.set('settings', `admin:${tab ?? 'general'}`);
	return `${routePaths.home}?${params.toString()}`;
}

/** `/admin/analytics[/<tab>]`: the analytics modal tab, or /admin when analytics is off. */
export function analyticsRedirectPath(config: BackendConfig | null): string {
	return (config?.features?.enable_admin_analytics ?? true)
		? `${routePaths.home}?settings=${encodeURIComponent('admin:analytics')}`
		: routePaths.admin;
}
