import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import {
	adminTabs,
	availableTabs,
	filterTabs,
	personalSettingsRestricted,
	personalTabs,
	plainTabTitle,
	resolveTab,
	serverTabPath,
	serverTabs,
	startsGroup
} from './settingsTabs';

const user = (role: string, permissions: Record<string, unknown> = {}) =>
	({ id: 'u', email: 'e', name: 'n', role, profile_image_url: '', permissions }) as SessionUser;
const adminOnly = new Set(adminTabs.map((t) => t.id));
const all = new Set([...adminTabs, ...personalTabs].map((t) => t.id));
const cfg = (features: Record<string, unknown> = {}) => ({ name: 'x', version: '1', features }) as never;

describe('availableTabs', () => {
	it('lists no server tab, even for an admin: those are pages under Admin (S5-D1)', () => {
		expect(availableTabs(user('admin'), cfg(), adminOnly)).toEqual([]);
		expect(availableTabs(user('user'), cfg(), adminOnly)).toEqual([]);
		expect(availableTabs(null, cfg(), all)).toEqual([]);
	});
	it('lists personal tabs first, by the Svelte visibility rules', () => {
		const ids = (u: SessionUser, f = {}) => availableTabs(u, cfg(f), all).map((t) => t.id);
		expect(ids(user('user'))).toEqual([
			'general',
			'interface',
			'notifications',
			'shortcuts',
			'audio',
			'data_controls',
			'archived_chats',
			'account',
			'about'
		]);
		expect(
			ids(user('user', { features: { direct_tool_servers: true }, settings: { interface: false } }), {
				enable_direct_connections: true,
				enable_memories: true
			})
		).toEqual(['data_controls', 'archived_chats', 'account', 'about']);
		expect(ids(user('admin'))[0]).toBe('general');
		expect(ids(user('admin')).some((id) => id.startsWith('admin:'))).toBe(false);
	});
	it('hides every personal tab that saves through the guarded endpoint without Interface Settings Access, and keeps the rest', () => {
		const off = user('user', {
			features: { direct_tool_servers: true, memories: true },
			settings: { interface: false }
		});
		const f = { enable_direct_connections: true, enable_memories: true };
		expect(availableTabs(off, cfg(f), all).map((t) => t.id)).toEqual([
			'data_controls',
			'archived_chats',
			'account',
			'about'
		]);
		expect(personalSettingsRestricted(off)).toBe(true);
		const adminOff = user('admin', { settings: { interface: false } });
		expect(personalSettingsRestricted(adminOff)).toBe(false);
		expect(availableTabs(adminOff, cfg(f), all).map((t) => t.id)).toContain('audio');
		expect(personalSettingsRestricted(user('user', { settings: { interface: true } }))).toBe(false);
		expect(personalSettingsRestricted(user('user'))).toBe(false);
	});
	it('hides Integrations (personal tool and terminal servers) from everyone until chats use them (#1090)', () => {
		const allowed = user('user', { features: { direct_tool_servers: true } });
		expect(availableTabs(allowed, cfg(), all).map((t) => t.id)).not.toContain('tools');
		expect(availableTabs(user('admin'), cfg(), all).map((t) => t.id)).not.toContain('tools');
		// Admin > Integrations, where tool servers do work, stays.
		expect(serverTabs(user('admin'), all).map((t) => t.id)).toContain('admin:integrations');
		expect(resolveTab('tools', null, availableTabs(user('admin'), cfg(), all))).toBe('general');
	});
	it('lists only tabs that have a component', () => {
		expect(availableTabs(user('admin'), cfg(), new Set(['about'])).map((t) => t.id)).toEqual(['about']);
		expect(serverTabs(user('admin'), new Set(['admin:db'])).map((t) => t.id)).toEqual(['admin:db']);
	});
});

describe('serverTabs (S5-D1, S5-D4)', () => {
	it('lists the server tabs for an admin only', () => {
		expect(serverTabs(user('user'), all)).toEqual([]);
		expect(serverTabs(null, all)).toEqual([]);
		expect(serverTabs(user('admin'), all)[0].id).toBe('admin:general');
	});
	it('leaves out Analytics, which is its own Admin tab', () => {
		expect(serverTabs(user('admin'), all).map((t) => t.id)).not.toContain('admin:analytics');
	});
	it('shows Pipelines only while a pipelines server is connected', () => {
		expect(serverTabs(user('admin'), all).map((t) => t.id)).not.toContain('admin:pipelines');
		expect(serverTabs(user('admin'), all, { pipelines: true }).map((t) => t.id)).toContain('admin:pipelines');
	});
});

describe('serverTabPath and plainTabTitle', () => {
	it('puts each server tab under /admin/settings, and Analytics at /admin/analytics', () => {
		expect(serverTabPath('admin:code-execution')).toBe('/admin/settings/code-execution');
		expect(serverTabPath('admin:analytics')).toBe('/admin/analytics');
		expect(serverTabPath(null)).toBe('/admin/settings');
	});
	it('drops the "Server: " a repeated name carries in the list', () => {
		const byId = (id: string) => adminTabs.find((t) => t.id === id) as (typeof adminTabs)[number];
		expect(plainTabTitle(byId('admin:connections'))).toBe('Connections');
		expect(plainTabTitle(byId('admin:db'))).toBe('Database');
	});
});

describe('filterTabs', () => {
	const tabs = serverTabs(user('admin'), adminOnly);
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
	const tabs = serverTabs(user('admin'), adminOnly);
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
