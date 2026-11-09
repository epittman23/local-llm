import type { ComponentType } from 'react';

/**
 * The dynamic import behind each Settings tab, personal and admin. The modal wraps each in `lazy` (a fresh one per Retry, since React caches a rejected import), so the modal's shell is
 * small and each tab (some are 1,000+ lines of form) is fetched only when
 * opened. A tab id absent from this map is not listed by the modal (see
 * `availableTabs`), which is how tabs are added one at a time without ever
 * showing a dead one.
 */
export const tabLoaders: Record<string, () => Promise<{ default: ComponentType }>> = {
	general: () => import('./personal/General'),
	interface: () => import('./personal/Interface'),
	notifications: () => import('./personal/Notifications'),
	shortcuts: () => import('./personal/Shortcuts'),
	connections: () => import('./personal/Connections'),
	tools: () => import('./personal/Integrations'),
	personalization: () => import('./personal/Personalization'),
	audio: () => import('./personal/Audio'),
	data_controls: () => import('./personal/DataControls'),
	archived_chats: () => import('./personal/ArchivedChats'),
	account: () => import('./personal/Account'),
	about: () => import('./personal/About'),
	'admin:general': () => import('@/routes/admin/settings/General'),
	'admin:authentication': () => import('@/routes/admin/settings/Authentication'),
	'admin:web': () => import('@/routes/admin/settings/WebSearch'),
	'admin:documents': () => import('@/routes/admin/settings/Documents'),
	'admin:images': () => import('@/routes/admin/settings/Images'),
	'admin:models': () => import('@/routes/admin/settings/models/AdminModels'),
	'admin:audio': () => import('@/routes/admin/settings/Audio'),
	'admin:connections': () => import('@/routes/admin/settings/Connections'),
	'admin:interface': () => import('@/routes/admin/settings/Interface'),
	'admin:integrations': () => import('@/routes/admin/settings/Integrations'),
	'admin:subagents': () => import('@/routes/admin/settings/Subagents'),
	'admin:analytics': () => import('@/routes/admin/analytics/Analytics'),
	'admin:evaluations': () => import('@/routes/admin/settings/Evaluations'),
	'admin:code-execution': () => import('@/routes/admin/settings/CodeExecution'),
	'admin:pipelines': () => import('@/routes/admin/settings/Pipelines'),
	'admin:db': () => import('@/routes/admin/settings/Database')
};

export const implementedTabIds: ReadonlySet<string> = new Set(Object.keys(tabLoaders));
