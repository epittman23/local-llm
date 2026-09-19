import type { SessionUser } from '@/lib/stores/authStore';
import type { BackendConfig } from '@/lib/stores/configStore';
import type { WorkspaceSection } from '@/lib/stores/workspaceStore';
import { routePaths } from '@/routes/routePaths';

// Section order is significant twice over: it is the tab order in the layout
// and the priority order in which a non-admin user is sent to the first
// section they can open (`+page.svelte`'s if/else chain, which also lists
// models -> knowledge -> prompts -> tools -> skills; the *tab* bar puts skills
// before tools. Both orders are preserved as written rather than unified).
export const tabOrder: WorkspaceSection[] = ['models', 'knowledge', 'prompts', 'skills', 'tools'];
const redirectOrder: WorkspaceSection[] = ['models', 'knowledge', 'prompts', 'tools', 'skills'];

export const sectionPaths: Record<WorkspaceSection, string> = {
	models: routePaths.workspaceModels,
	knowledge: routePaths.workspaceKnowledge,
	prompts: routePaths.workspacePrompts,
	skills: routePaths.workspaceSkills,
	tools: routePaths.workspaceTools
};

/**
 * Whether `user` may open a workspace section. Admins may open every section
 * except Tools when the backend has plugins turned off -- Svelte's tab bar
 * gates Tools on `enable_plugins` for admins too, while its onMount redirect
 * exempts admins from *all* per-section checks (a stale bookmark to
 * /workspace/tools as an admin with plugins off renders the page; the tab is
 * simply hidden). That asymmetry is kept: this is the tab-visibility rule,
 * and `canEnterSection` below is the redirect rule.
 */
export function canSeeTab(
	user: SessionUser | null,
	config: BackendConfig | null,
	section: WorkspaceSection
): boolean {
	if (section === 'tools' && !config?.features?.enable_plugins) return false;
	return user?.role === 'admin' || Boolean(user?.permissions?.workspace?.[section]);
}

/** The redirect rule from `workspace/+layout.svelte`'s onMount. */
export function canEnterSection(
	user: SessionUser | null,
	config: BackendConfig | null,
	section: WorkspaceSection
): boolean {
	if (user?.role === 'admin') return true;
	if (section === 'tools' && !config?.features?.enable_plugins) return false;
	return Boolean(user?.permissions?.workspace?.[section]);
}

/** Where bare `/workspace` should send this user (`workspace/+page.svelte`). */
export function defaultWorkspacePath(user: SessionUser | null, config: BackendConfig | null) {
	if (user?.role === 'admin') return routePaths.workspaceModels;
	const first = redirectOrder.find((section) => canEnterSection(user, config, section));
	return first ? sectionPaths[first] : routePaths.home;
}

/** `/workspace/prompts/create` -> `prompts`; anything else -> null. */
export function sectionOfPath(pathname: string): WorkspaceSection | null {
	const segment = pathname.split('/')[2] ?? '';
	return (tabOrder as string[]).includes(segment) ? (segment as WorkspaceSection) : null;
}
