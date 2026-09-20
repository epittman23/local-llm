import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, setPermission, withDefaults } from './permissions';

describe('withDefaults', () => {
	it('fills every group from the defaults when nothing is loaded', () => {
		expect(withDefaults(null)).toEqual(DEFAULT_PERMISSIONS);
		expect(withDefaults({})).toEqual(DEFAULT_PERMISSIONS);
	});
	it('overlays loaded values and keeps the keys they do not mention', () => {
		const merged = withDefaults({ workspace: { models: true }, chat: { edit: false } });
		expect(merged.workspace.models).toBe(true);
		expect(merged.workspace.knowledge).toBe(false);
		expect(merged.chat.edit).toBe(false);
		expect(merged.chat.delete).toBe(true);
	});
	it('passes unknown groups through', () => {
		expect((withDefaults({ future: { x: true } }) as Record<string, unknown>).future).toEqual({ x: true });
	});
	it('does not mutate the defaults', () => {
		const merged = withDefaults({});
		merged.workspace.models = true;
		expect(DEFAULT_PERMISSIONS.workspace.models).toBe(false);
	});
});

describe('setPermission', () => {
	it('changes one switch and leaves the input alone', () => {
		const before = withDefaults({});
		const after = setPermission(before, 'features', 'webhooks', true);
		expect(after.features.webhooks).toBe(true);
		expect(before.features.webhooks).toBe(false);
		expect(after.chat).toBe(before.chat);
	});
});
