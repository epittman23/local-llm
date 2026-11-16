import type { SessionUser } from '@/lib/stores/authStore';
import type { BackendConfig } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

export type AdminGate = { allowed: true } | { allowed: false; redirectTo: string };

/**
 * The redirect rule from admin/+layout.svelte's onMount: a non-admin goes home;
 * an admin who opens /admin/functions/** while plugins are off goes to /admin
 * (which then lands on Users), and so does one who opens /admin/analytics
 * while admin analytics is off. The Functions and Analytics *tabs* are hidden
 * under the same conditions, so the two stay in step.
 */
export function adminGate(user: SessionUser | null, config: BackendConfig | null, pathname: string): AdminGate {
	if (user?.role !== 'admin') return { allowed: false, redirectTo: routePaths.home };
	if (!config?.features?.enable_plugins && isFunctionsPath(pathname)) {
		return { allowed: false, redirectTo: routePaths.admin };
	}
	if (!analyticsOn(config) && adminSectionOfPath(pathname) === 'analytics') {
		return { allowed: false, redirectTo: routePaths.admin };
	}
	return { allowed: true };
}

/** Admin analytics is on unless the server turns it off (`enable_admin_analytics`, default on). */
export const analyticsOn = (config: BackendConfig | null) => config?.features?.enable_admin_analytics ?? true;

// `includes`, as the Svelte layout does, not a prefix test: `pathname` from
// react-router is already base-relative, but matching the original keeps
// behaviour identical.
export const isFunctionsPath = (pathname: string) => pathname.includes('/admin/functions');

export type AdminSection = 'users' | 'evaluations' | 'analytics' | 'functions' | 'settings';

/** Which top-level tab a path belongs to (`pathname.includes` in the layout). */
export function adminSectionOfPath(pathname: string): AdminSection | null {
	if (pathname.includes('/admin/users')) return 'users';
	if (pathname.includes('/admin/evaluations')) return 'evaluations';
	if (pathname.includes('/admin/analytics')) return 'analytics';
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
