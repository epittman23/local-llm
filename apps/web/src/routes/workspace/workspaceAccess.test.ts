import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/stores/authStore';
import type { BackendConfig } from '@/lib/stores/configStore';
import {
	canEnterSection,
	canSeeTab,
	defaultWorkspacePath,
	sectionOfPath
} from './workspaceAccess';

const user = (role: string, workspace: Record<string, boolean> = {}): SessionUser => ({
	id: 'u',
	email: 'u@example.com',
	name: 'U',
	role,
	profile_image_url: '',
	permissions: { workspace }
});
const config = (enable_plugins: boolean): BackendConfig => ({
	name: 'x',
	version: 't',
	features: { enable_plugins }
});

describe('workspace access', () => {
	it('hides the Tools tab from everyone, admins included, when plugins are off', () => {
		expect(canSeeTab(user('admin'), config(false), 'tools')).toBe(false);
		expect(canSeeTab(user('admin'), config(true), 'tools')).toBe(true);
	});

	// The asymmetry inherited from workspace/+layout.svelte: the tab bar checks
	// enable_plugins for admins, but the onMount redirect exempts admins from
	// every per-section check. A stale /workspace/tools bookmark still opens.
	it('lets an admin enter Tools by URL even with plugins off', () => {
		expect(canEnterSection(user('admin'), config(false), 'tools')).toBe(true);
	});

	it('requires the matching permission from a non-admin', () => {
		const u = user('user', { prompts: true });
		expect(canEnterSection(u, config(true), 'prompts')).toBe(true);
		expect(canEnterSection(u, config(true), 'models')).toBe(false);
		expect(canEnterSection(user('user', { tools: true }), config(false), 'tools')).toBe(false);
	});

	it('sends bare /workspace to the first permitted section, tools before skills', () => {
		expect(defaultWorkspacePath(user('admin'), config(true))).toBe('/workspace/models');
		expect(defaultWorkspacePath(user('user', { skills: true, tools: true }), config(true))).toBe(
			'/workspace/tools'
		);
		expect(defaultWorkspacePath(user('user', { skills: true }), config(true))).toBe(
			'/workspace/skills'
		);
		expect(defaultWorkspacePath(user('user'), config(true))).toBe('/');
	});

	it('reads the section from the second path segment', () => {
		expect(sectionOfPath('/workspace/prompts/create')).toBe('prompts');
		expect(sectionOfPath('/workspace')).toBeNull();
		expect(sectionOfPath('/workspace/functions/create')).toBeNull();
	});
});
