import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

/**
 * The component behind each admin Settings tab. Lazy, so the modal's shell is
 * small and each tab (some are 1,000+ lines of form) is fetched only when
 * opened. A tab id absent from this map is not listed by the modal (see
 * `availableTabs`), which is how tabs are added one at a time without ever
 * showing a dead one.
 */
export const adminTabComponents: Record<string, LazyExoticComponent<ComponentType>> = {
	'admin:general': lazy(() => import('@/routes/admin/settings/General')),
	'admin:connections': lazy(() => import('@/routes/admin/settings/Connections')),
	'admin:interface': lazy(() => import('@/routes/admin/settings/Interface')),
	'admin:subagents': lazy(() => import('@/routes/admin/settings/Subagents')),
	'admin:analytics': lazy(() => import('@/routes/admin/analytics/Analytics')),
	'admin:evaluations': lazy(() => import('@/routes/admin/settings/Evaluations')),
	'admin:code-execution': lazy(() => import('@/routes/admin/settings/CodeExecution')),
	'admin:pipelines': lazy(() => import('@/routes/admin/settings/Pipelines')),
	'admin:db': lazy(() => import('@/routes/admin/settings/Database'))
};

export const implementedTabIds: ReadonlySet<string> = new Set(Object.keys(adminTabComponents));
