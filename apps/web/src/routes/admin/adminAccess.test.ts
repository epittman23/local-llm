import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import { adminGate, adminSectionOfPath, analyticsOn, tabFromPath } from './adminAccess';

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
		expect(adminGate(user('admin'), cfg(false), '/admin/functions/edit')).toEqual({
			allowed: false,
			redirectTo: '/admin'
		});
		expect(adminGate(user('admin'), cfg(true), '/admin/functions/edit')).toEqual({ allowed: true });
		expect(adminGate(user('admin'), cfg(false), '/admin/evaluations')).toEqual({ allowed: true });
	});
});

describe('adminSectionOfPath', () => {
	it('maps each tab, and nothing else', () => {
		expect(adminSectionOfPath('/admin/users/groups')).toBe('users');
		expect(adminSectionOfPath('/admin/evaluations/feedback')).toBe('evaluations');
		expect(adminSectionOfPath('/admin/functions/create')).toBe('functions');
		expect(adminSectionOfPath('/admin/analytics')).toBe('analytics');
		expect(adminSectionOfPath('/admin/settings/connections')).toBe('settings');
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

describe('Analytics, an Admin tab of its own (S5-D1)', () => {
	it('lets an admin open /admin/analytics while admin analytics is on', () => {
		expect(adminGate(user('admin'), cfg(true), '/admin/analytics')).toEqual({ allowed: true });
		expect(analyticsOn(cfg(true))).toBe(true);
		expect(analyticsOn(null)).toBe(true);
	});
	it('sends /admin/analytics to /admin while it is off, and nothing else', () => {
		const off = cfg(true, { enable_admin_analytics: false });
		expect(analyticsOn(off)).toBe(false);
		expect(adminGate(user('admin'), off, '/admin/analytics')).toEqual({ allowed: false, redirectTo: '/admin' });
		expect(adminGate(user('admin'), off, '/admin/settings/general')).toEqual({ allowed: true });
	});
});
