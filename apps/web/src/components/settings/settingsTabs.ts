import type { SessionUser } from '@/lib/stores/authStore';
import type { BackendConfig } from '@/lib/stores/configStore';

export type SettingsTab = {
	id: string;
	title: string;
	/** Lower-case words the modal's search box matches, besides the title. */
	keywords: string[];
	/** The heading it sits under in the tab list. */
	group: string;
};

/**
 * The admin tabs of chat/SettingsModal.svelte, in its order, with its search
 * keywords and its group headings. (The modal's personal tabs -- General,
 * Interface, Account, ... -- belong to Phase 10 and will be registered beside
 * these; the modal already lists whichever section has tabs.)
 */
export const adminTabs: SettingsTab[] = [
	{ id: 'admin:general', title: 'General', group: 'System', keywords: ['general', 'admin', 'settings', 'version', 'update', 'community', 'channels'] },
	{ id: 'admin:authentication', title: 'Authentication', group: 'System', keywords: ['authentication', 'auth', 'login', 'signup', 'ldap', 'oauth', 'oidc', 'sso', 'roles'] },
	{ id: 'admin:connections', title: 'Connections', group: 'AI', keywords: ['connections', 'ollama', 'openai', 'api', 'base url', 'direct connections', 'proxy'] },
	{ id: 'admin:models', title: 'Models', group: 'AI', keywords: ['models', 'pull', 'delete', 'create', 'edit', 'modelfile', 'gguf', 'import', 'export'] },
	{ id: 'admin:subagents', title: 'Sub-agents', group: 'AI', keywords: ['sub-agents', 'subagents', 'delegation', 'background', 'agents'] },
	{ id: 'admin:interface', title: 'Interface', group: 'Experience', keywords: ['interface', 'ui', 'appearance', 'banners', 'tasks', 'prompt suggestions', 'tags'] },
	{ id: 'admin:audio', title: 'Audio', group: 'Experience', keywords: ['audio', 'voice', 'speech', 'tts', 'stt', 'whisper', 'deepgram', 'azure'] },
	{ id: 'admin:images', title: 'Images', group: 'Experience', keywords: ['images', 'generation', 'dalle', 'stable diffusion', 'comfyui', 'automatic1111'] },
	{ id: 'admin:evaluations', title: 'Evaluations', group: 'Quality', keywords: ['evaluations', 'feedback', 'rating', 'arena', 'leaderboard', 'preference'] },
	{ id: 'admin:analytics', title: 'Analytics', group: 'Quality', keywords: ['analytics', 'usage', 'stats', 'dashboard', 'models', 'users', 'messages'] },
	{ id: 'admin:integrations', title: 'Integrations', group: 'Tools', keywords: ['tools', 'integrations', 'plugins', 'extensions', 'functions', 'openapi', 'server'] },
	{ id: 'admin:documents', title: 'Documents', group: 'Tools', keywords: ['documents', 'files', 'rag', 'knowledge', 'upload', 'embedding', 'vector db'] },
	{ id: 'admin:web', title: 'Web Search', group: 'Tools', keywords: ['web search', 'google', 'bing', 'duckduckgo', 'serp', 'searxng', 'tavily', 'exa'] },
	{ id: 'admin:code-execution', title: 'Code Execution', group: 'Tools', keywords: ['code execution', 'python', 'sandbox', 'compiler', 'jupyter', 'interpreter'] },
	{ id: 'admin:pipelines', title: 'Pipelines', group: 'Tools', keywords: ['pipelines', 'workflows', 'filters', 'valves', 'middleware'] },
	{ id: 'admin:db', title: 'Database', group: 'Data', keywords: ['database', 'export', 'import', 'backup', 'chats', 'users'] }
];

export const isAdminTab = (id: string) => id.startsWith('admin:');

/**
 * Tabs this user can open. `implemented` is the set of tab ids that have a
 * component in this app so far (the modal passes its registry), so a tab is
 * never listed before it works. Analytics also needs `enable_admin_analytics`
 * (default on), which the Svelte modal checks at filter time.
 */
export function availableTabs(user: SessionUser | null, config: BackendConfig | null, implemented: ReadonlySet<string>): SettingsTab[] {
	if (user?.role !== 'admin') return [];
	return adminTabs.filter((t) => implemented.has(t.id) && (t.id !== 'admin:analytics' || (config?.features?.enable_admin_analytics ?? true)));
}

/** The search box: case-insensitive, matches the title or any keyword by substring. */
export function filterTabs(tabs: SettingsTab[], search: string): SettingsTab[] {
	const query = search.toLowerCase().trim();
	if (query === '') return tabs;
	return tabs.filter((t) => t.title.toLowerCase().includes(query) || t.keywords.some((k) => k.includes(query)));
}

/**
 * Which tab to show: the requested one if it is listed, else keep the current
 * selection if it still is, else the first listed (the modal's own
 * "selection fell out of the filtered list" rule). null when nothing is listed.
 */
export function resolveTab(requested: string | null, current: string | null, tabs: SettingsTab[]): string | null {
	const ids = tabs.map((t) => t.id);
	if (requested && ids.includes(requested)) return requested;
	if (current && ids.includes(current)) return current;
	return ids[0] ?? null;
}

/** True when `tabs[index]` starts a new group heading. */
export const startsGroup = (tabs: SettingsTab[], index: number) => index === 0 || tabs[index].group !== tabs[index - 1].group;

/** `admin:code-execution` -> `code-execution` (the AdminTabIcon key and the URL segment). */
export const adminTabSegment = (id: string) => id.replace('admin:', '');
