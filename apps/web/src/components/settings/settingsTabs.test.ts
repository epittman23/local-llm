import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import { adminTabs, availableTabs, filterTabs, personalTabs, resolveTab, startsGroup } from './settingsTabs';

const user = (role: string, permissions: Record<string, unknown> = {}) => ({ id: 'u', email: 'e', name: 'n', role, profile_image_url: '', permissions }) as SessionUser;
const adminOnly = new Set(adminTabs.map((t) => t.id));
const all = new Set([...adminTabs, ...personalTabs].map((t) => t.id));
const cfg = (features: Record<string, unknown> = {}) => ({ name: 'x', version: '1', features }) as never;

describe('availableTabs', () => {
	it('lists every implemented admin tab for an admin, and no admin tab for anyone else', () => {
		expect(availableTabs(user('admin'), cfg(), adminOnly)).toHaveLength(adminTabs.length);
		expect(availableTabs(user('user'), cfg(), adminOnly)).toEqual([]);
		expect(availableTabs(null, cfg(), all)).toEqual([]);
	});
	it('lists personal tabs first, by the Svelte visibility rules', () => {
		const ids = (u: SessionUser, f = {}) => availableTabs(u, cfg(f), all).map((t) => t.id);
		expect(ids(user('user'))).toEqual(['general', 'interface', 'notifications', 'shortcuts', 'audio', 'data_controls', 'archived_chats', 'account', 'about']);
		expect(ids(user('user', { features: { direct_tool_servers: true }, settings: { interface: false } }), { enable_direct_connections: true, enable_memories: true })).toEqual(['general', 'notifications', 'shortcuts', 'connections', 'tools', 'personalization', 'audio', 'data_controls', 'archived_chats', 'account', 'about']);
		expect(ids(user('admin'))[0]).toBe('general');
		expect(ids(user('admin'))).toContain('admin:general');
	});
	it('lists only tabs that have a component', () => {
		expect(availableTabs(user('admin'), cfg(), new Set(['admin:db'])).map((t) => t.id)).toEqual(['admin:db']);
	});
	it('drops Analytics when the feature is off, but keeps it by default', () => {
		expect(availableTabs(user('admin'), cfg({ enable_admin_analytics: false }), all).map((t) => t.id)).not.toContain('admin:analytics');
		expect(availableTabs(user('admin'), cfg(), all).map((t) => t.id)).toContain('admin:analytics');
	});
});

describe('filterTabs', () => {
	const tabs = availableTabs(user('admin'), cfg(), adminOnly);
	it('returns everything for a blank search', () => {
		expect(filterTabs(tabs, '  ')).toHaveLength(tabs.length);
	});
	it('matches titles and keywords case-insensitively', () => {
		expect(filterTabs(tabs, 'WHISPER').map((t) => t.id)).toEqual(['admin:audio']);
		expect(filterTabs(tabs, 'sandbox').map((t) => t.id)).toEqual(['admin:code-execution']);
		expect(filterTabs(tabs, 'nothing matches this')).toEqual([]);
	});
});

describe('resolveTab', () => {
	const tabs = availableTabs(user('admin'), cfg(), adminOnly);
	it('prefers the requested tab, then the current one, then the first', () => {
		expect(resolveTab('admin:audio', 'admin:db', tabs)).toBe('admin:audio');
		expect(resolveTab('admin:nope', 'admin:db', tabs)).toBe('admin:db');
		expect(resolveTab(null, 'admin:gone', tabs)).toBe('admin:general');
		expect(resolveTab(null, null, [])).toBeNull();
	});
});

describe('startsGroup', () => {
	it('marks the first tab and each change of group', () => {
		const tabs = adminTabs.filter((t) => ['admin:general', 'admin:authentication', 'admin:connections'].includes(t.id));
		expect(tabs.map((_, i) => startsGroup(tabs, i))).toEqual([true, false, true]);
	});
});
