import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import { adminTabs, availableTabs, filterTabs, resolveTab, startsGroup } from './settingsTabs';

const user = (role: string) => ({ id: 'u', email: 'e', name: 'n', role, profile_image_url: '' }) as SessionUser;
const all = new Set(adminTabs.map((t) => t.id));
const cfg = (features: Record<string, unknown> = {}) => ({ name: 'x', version: '1', features }) as never;

describe('availableTabs', () => {
	it('lists every implemented admin tab for an admin, and nothing for anyone else', () => {
		expect(availableTabs(user('admin'), cfg(), all)).toHaveLength(adminTabs.length);
		expect(availableTabs(user('user'), cfg(), all)).toEqual([]);
		expect(availableTabs(null, cfg(), all)).toEqual([]);
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
	const tabs = availableTabs(user('admin'), cfg(), all);
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
	const tabs = availableTabs(user('admin'), cfg(), all);
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
