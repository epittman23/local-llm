import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, withDefaults } from '@/lib/access/permissions';
import { layoutRows, permissionSections, showsDefaultHint, visibleRows } from './permissionRows';

const ctx = { pluginsEnabled: true };
const section = (title: string) => permissionSections.find((s) => s.title === title)!;
const keys = (rows: { group: string; key: string }[]) => rows.map((r) => `${r.group}.${r.key}`);

describe('permissionSections', () => {
	it('covers every key of every default group exactly once', () => {
		const shown = keys(permissionSections.flatMap((s) => s.rows));
		const expected = Object.entries(DEFAULT_PERMISSIONS).flatMap(([g, v]) => Object.keys(v).map((k) => `${g}.${k}`));
		expect([...shown].sort()).toEqual([...expected].sort());
		expect(new Set(shown).size).toBe(shown.length);
	});
});

describe('visibleRows', () => {
	it('hides Import/Export until the parent workspace switch is on', () => {
		const off = withDefaults({});
		expect(keys(visibleRows(section('Workspace Permissions'), off, ctx))).not.toContain('workspace.models_import');
		const on = withDefaults({ workspace: { models: true } });
		expect(keys(visibleRows(section('Workspace Permissions'), on, ctx))).toContain('workspace.models_import');
	});
	it('hides all of Tools when plugins are off, even with the switch on', () => {
		const p = withDefaults({ workspace: { tools: true } });
		const rows = keys(visibleRows(section('Workspace Permissions'), p, { pluginsEnabled: false }));
		expect(rows.filter((r) => r.startsWith('workspace.tools'))).toEqual([]);
		expect(keys(visibleRows(section('Workspace Permissions'), p, ctx))).toContain('workspace.tools_export');
	});
	it('shows Public Sharing only while its sharing switch is on', () => {
		const rows = (p: Record<string, unknown>) => keys(visibleRows(section('Sharing Permissions'), withDefaults(p), ctx));
		expect(rows({})).not.toContain('sharing.public_notes');
		expect(rows({ sharing: { notes: true } })).toContain('sharing.public_notes');
	});
	it('ties chat sharing to Allow Chat Share, and calendar sharing to the Calendar feature', () => {
		const rows = (p: Record<string, unknown>) => keys(visibleRows(section('Sharing Permissions'), withDefaults(p), ctx));
		expect(rows({ chat: { share: false } })).not.toContain('sharing.public_chats');
		expect(rows({ chat: { share: true } })).toContain('sharing.open_chats');
		expect(rows({ features: { calendar: false } })).not.toContain('sharing.public_calendars');
	});
	it('hides chat valves/system prompt/params without Chat Controls, and Enforce without Temporary', () => {
		const rows = (p: Record<string, unknown>) => keys(visibleRows(section('Chat Permissions'), withDefaults(p), ctx));
		expect(rows({ chat: { controls: false } })).not.toContain('chat.valves');
		expect(rows({})).toContain('chat.params');
		expect(rows({ chat: { temporary: false } })).not.toContain('chat.temporary_enforced');
	});
});

describe('showsDefaultHint', () => {
	const row = { group: 'chat', key: 'edit', label: 'x' } as const;
	it('fires when the default is on and this group turned it off', () => {
		const p = withDefaults({ chat: { edit: false } });
		expect(showsDefaultHint(row, p, { chat: { edit: true } } as never)).toBe(true);
	});
	it('stays quiet when the switch is on, the default is off, or the row is nested', () => {
		expect(showsDefaultHint(row, withDefaults({}), { chat: { edit: true } } as never)).toBe(false);
		expect(showsDefaultHint(row, withDefaults({ chat: { edit: false } }), { chat: { edit: false } } as never)).toBe(false);
		expect(showsDefaultHint({ ...row, nested: true }, withDefaults({ chat: { edit: false } }), { chat: { edit: true } } as never)).toBe(false);
	});
});

describe('layoutRows', () => {
	it('groups a parent with its Import/Export block, in order', () => {
		const p = withDefaults({ workspace: { models: true, prompts: true } });
		const blocks = layoutRows(visibleRows(section('Workspace Permissions'), p, ctx));
		const shape = blocks.map((b) => (Array.isArray(b) ? keys(b) : keys([b])[0]));
		expect(shape.slice(0, 5)).toEqual([
			'workspace.models',
			['workspace.models_import', 'workspace.models_export'],
			'workspace.knowledge',
			'workspace.prompts',
			['workspace.prompts_import', 'workspace.prompts_export']
		]);
	});
});
