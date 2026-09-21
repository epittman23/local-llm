import type { EventWebhook, EventWebhookTarget } from '@/lib/apis';

// The rules behind Events.tsx (ported from admin/Settings/Events.svelte), kept
// out of the component so they can be tested without rendering it.

export type TargetMode = 'all' | 'system' | 'selected';

export type WebhookForm = { id: string; name: string; url: string; enabled: boolean; events: string[] };

export const blankForm = (): WebhookForm => ({ id: '', name: '', url: '', enabled: true, events: ['*'] });

/** The built-in `default` webhook first, the rest by name. */
export const sortWebhooks = (items: EventWebhook[]): EventWebhook[] =>
	[...items].sort((a, b) => {
		if (a.id === 'default') return -1;
		if (b.id === 'default') return 1;
		return (a.name || '').localeCompare(b.name || '');
	});

export const eventSummary = (webhook: EventWebhook): string => {
	const filters = webhook.events?.length ? webhook.events : ['*'];
	if (filters.includes('*')) return 'All events';
	if (filters.length <= 2) return filters.join(' + ');
	return `${filters.length} filters`;
};

/** `targets` null means "everyone"; an empty list means "system events only". */
export const targetSummary = (webhook: EventWebhook): string => {
	const targets = webhook.targets;
	if (targets === null || targets === undefined) return 'All users and system events';
	if (targets.length === 0) return 'System events only';
	const users = targets.filter((t) => t.type === 'user').length;
	const groups = targets.filter((t) => t.type === 'group').length;
	const parts: string[] = [];
	if (users > 0) parts.push(users === 1 ? '1 user' : `${users} users`);
	if (groups > 0) parts.push(groups === 1 ? '1 group' : `${groups} groups`);
	return parts.join(' + ');
};

export const urlHost = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return url || 'Not configured';
	}
};

/** The catalog entries the search box narrows to (a trailing `*` is ignored). */
export const filterEvents = (events: string[], pattern: string): string[] => {
	const needle = pattern.trim().toLowerCase().replace(/\*$/, '');
	return events.filter((event) => !needle || event.includes(needle));
};

/** `*`, an exact catalog event, or a `prefix.*` that matches at least one. */
export const isValidPattern = (value: string, events: string[]): boolean => {
	if (value === '*') return true;
	if (events.includes(value)) return true;
	if (!value.endsWith('.*')) return false;
	return events.some((event) => event.startsWith(value.slice(0, -1)));
};

/** Adds a filter; `*` replaces everything, anything else drops a standing `*`. */
export const addFilter = (current: string[], value: string): string[] =>
	value === '*' ? ['*'] : [...new Set(current.filter((e) => e !== '*').concat(value))];

export const toggleEvent = (current: string[], event: string): string[] => {
	const selected = new Set(current.filter((e) => e !== '*'));
	if (selected.has(event)) selected.delete(event);
	else selected.add(event);
	return [...selected].sort();
};

/** Removing the last filter falls back to "all events" rather than to none. */
export const removeFilter = (current: string[], event: string): string[] => {
	const next = current.filter((e) => e !== event);
	return next.length === 0 ? ['*'] : next;
};

export const setAllEvents = (enabled: boolean): string[] => (enabled ? ['*'] : []);

export const targetsFor = (mode: TargetMode, userIds: string[], groupIds: string[]): EventWebhookTarget[] | null => {
	if (mode === 'all') return null;
	if (mode === 'system') return [];
	return [...userIds.map((id) => ({ type: 'user' as const, id })), ...groupIds.map((id) => ({ type: 'group' as const, id }))];
};

export const targetsToState = (targets: EventWebhookTarget[] | null | undefined): { mode: TargetMode; userIds: string[]; groupIds: string[] } => {
	if (targets === null || targets === undefined) return { mode: 'all', userIds: [], groupIds: [] };
	return {
		mode: targets.length > 0 ? 'selected' : 'system',
		userIds: targets.filter((t) => t.type === 'user').map((t) => t.id),
		groupIds: targets.filter((t) => t.type === 'group').map((t) => t.id)
	};
};

export const webhookPayload = (form: WebhookForm, targets: EventWebhookTarget[] | null) => ({
	name: form.name || (form.id === 'default' ? 'Default webhook' : 'Webhook'),
	url: form.url,
	enabled: form.enabled,
	events: form.events.length ? form.events : ['*'],
	targets
});

/** The backend rejects with `{detail}`; the Svelte tab only handled a bare string. */
export const errorMessage = (error: unknown, fallback: string): string => {
	if (typeof error === 'string') return error;
	const detail = (error as { detail?: unknown } | null)?.detail;
	return typeof detail === 'string' ? detail : fallback;
};
