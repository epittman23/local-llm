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
 * The personal tabs of chat/SettingsModal.svelte, in its order, with its
 * group headings and (a shortened list of) its search keywords.
 */
export const personalTabs: SettingsTab[] = [
	{ id: 'general', title: 'General', group: 'Basics', keywords: ['general', 'theme', 'language', 'system prompt', 'advanced parameters', 'advanced params', 'keep alive', 'request mode'] },
	{ id: 'interface', title: 'Interface', group: 'Basics', keywords: ['interface', 'ui', 'chat bubble', 'widescreen', 'chat direction', 'title autogeneration', 'follow up', 'auto copy', 'image compression', 'rich text input', 'haptic feedback', 'high contrast'] },
	{ id: 'notifications', title: 'Notifications', group: 'Basics', keywords: ['notifications', 'browser notifications', 'notification sound', 'webhook', 'webhooks', 'notify'] },
	{ id: 'shortcuts', title: 'Keyboard', group: 'Basics', keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keybindings', 'keys', 'commands'] },
	{ id: 'connections', title: 'Connections', group: 'Services', keywords: ['connections', 'add connection', 'direct connections', 'manage connections'] },
	{ id: 'tools', title: 'Integrations', group: 'Services', keywords: ['integrations', 'tools', 'tool servers', 'manage tools', 'terminal', 'open terminal'] },
	{ id: 'personalization', title: 'Personalization', group: 'Preferences', keywords: ['personalization', 'memory', 'memories', 'personalize', 'experimental'] },
	{ id: 'audio', title: 'Audio', group: 'Preferences', keywords: ['audio', 'voice', 'speech', 'text to speech', 'speech to text', 'playback', 'auto send', 'stt', 'tts'] },
	{ id: 'data_controls', title: 'Data Controls', group: 'Data', keywords: ['data', 'import chats', 'export chats', 'archive all chats', 'delete all chats', 'chat history'] },
	{ id: 'archived_chats', title: 'Archived Chats', group: 'Data', keywords: ['archived', 'archive', 'unarchive', 'archived chats'] },
	{ id: 'account', title: 'Account', group: 'Profile', keywords: ['account', 'profile', 'password', 'change password', 'api keys', 'profile image', 'username'] },
	{ id: 'about', title: 'About', group: 'Profile', keywords: ['about', 'version', 'check for updates', 'license', 'help', 'documentation'] }
];

type Perms = { features?: Record<string, boolean>; settings?: Record<string, boolean> };

/** SettingsModal.svelte's rules for who sees which personal tab. */
function personalTabVisible(id: string, user: SessionUser, config: BackendConfig | null): boolean {
	const admin = user.role === 'admin';
	const perms = (user.permissions ?? {}) as Perms;
	const features = (config?.features ?? {}) as Record<string, unknown>;
	switch (id) {
		case 'connections':
			return Boolean(features.enable_direct_connections);
		case 'tools':
			return admin || Boolean(perms.features?.direct_tool_servers);
		case 'interface':
			return admin || (perms.settings?.interface ?? true);
		case 'personalization':
			return Boolean(features.enable_memories) && (admin || (perms.features?.memories ?? true));
		default:
			return true;
	}
}

/** The admin tabs of chat/SettingsModal.svelte, in its order, with its search keywords and its group headings. */
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
 * Tabs this user can open: their personal tabs, then (for an admin) the admin ones. `implemented` is the set of tab ids that have a
 * component in this app so far (the modal passes its registry), so a tab is
 * never listed before it works. Analytics also needs `enable_admin_analytics`
 * (default on), which the Svelte modal checks at filter time.
 */
export function availableTabs(user: SessionUser | null, config: BackendConfig | null, implemented: ReadonlySet<string>): SettingsTab[] {
	if (!user) return [];
	const personal = personalTabs.filter((t) => implemented.has(t.id) && personalTabVisible(t.id, user, config));
	if (user.role !== 'admin') return personal;
	return [...personal, ...adminTabs.filter((t) => implemented.has(t.id) && (t.id !== 'admin:analytics' || (config?.features?.enable_admin_analytics ?? true)))];
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
