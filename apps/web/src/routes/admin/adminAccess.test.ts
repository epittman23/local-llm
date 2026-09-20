import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import { adminGate, adminSectionOfPath, analyticsRedirectPath, settingsRedirectPath, tabFromPath } from './adminAccess';

const user = (role: string) => ({ id: 'u', email: 'e', name: 'n', role, profile_image_url: '' }) as SessionUser;
const cfg = (enable_plugins: boolean, extra: Record<string, unknown> = {}) =>
	({ name: 'x', version: '1', features: { enable_plugins, ...extra } }) as never;

describe('adminGate', () => {
	it('sends non-admins and anonymous visitors home', () => {
		expect(adminGate(user('user'), cfg(true), '/admin/users')).toEqual({ allowed: false, redirectTo: '/' });
		expect(adminGate(null, cfg(true), '/admin/users')).toEqual({ allowed: false, redirectTo: '/' });
	});
	it('lets an admin in', () => {
		expect(adminGate(user('admin'), cfg(false), '/admin/users/overview')).toEqual({ allowed: true });
	});
	it('bounces an admin off /admin/functions when plugins are off, and only there', () => {
		expect(adminGate(user('admin'), cfg(false), '/admin/functions/edit')).toEqual({ allowed: false, redirectTo: '/admin' });
		expect(adminGate(user('admin'), cfg(true), '/admin/functions/edit')).toEqual({ allowed: true });
		expect(adminGate(user('admin'), cfg(false), '/admin/evaluations')).toEqual({ allowed: true });
	});
});

describe('adminSectionOfPath', () => {
	it('maps each tab, and nothing else', () => {
		expect(adminSectionOfPath('/admin/users/groups')).toBe('users');
		expect(adminSectionOfPath('/admin/evaluations/feedback')).toBe('evaluations');
		expect(adminSectionOfPath('/admin/functions/create')).toBe('functions');
		expect(adminSectionOfPath('/admin')).toBeNull();
	});
});

describe('tabFromPath', () => {
	const tabs = ['overview', 'groups'] as const;
	it('takes the last segment when it is a known tab', () => {
		expect(tabFromPath('/admin/users/groups', tabs)).toBe('groups');
		expect(tabFromPath('/admin/users/groups/', tabs)).toBe('groups');
	});
	it('falls back to the first tab', () => {
		expect(tabFromPath('/admin/users', tabs)).toBe('overview');
		expect(tabFromPath('/admin/users/nope', tabs)).toBe('overview');
	});
});

describe('settings redirects', () => {
	it('builds the modal URL and keeps other params', () => {
		expect(settingsRedirectPath('connections', '')).toBe('/?settings=admin%3Aconnections');
		expect(settingsRedirectPath(undefined, '?x=1')).toBe('/?x=1&settings=admin%3Ageneral');
	});
	it('routes analytics to the modal unless the feature is off', () => {
		expect(analyticsRedirectPath(cfg(true))).toBe('/?settings=admin%3Aanalytics');
		expect(analyticsRedirectPath(cfg(true, { enable_admin_analytics: false }))).toBe('/admin');
		expect(analyticsRedirectPath(null)).toBe('/?settings=admin%3Aanalytics');
	});
});
