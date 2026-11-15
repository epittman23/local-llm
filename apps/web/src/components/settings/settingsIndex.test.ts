import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, searchSettings } from './settingsIndex';
import { personalTabs } from './settingsTabs';

/** The file each hand-listed tab is drawn by. */
const TAB_FILES: Record<string, string> = {
	general: 'personal/General.tsx',
	notifications: 'personal/Notifications.tsx',
	shortcuts: 'personal/Shortcuts.tsx',
	personalization: 'personal/Personalization.tsx',
	audio: 'personal/Audio.tsx',
	data_controls: 'personal/DataControls.tsx',
	account: 'personal/Account.tsx',
	interface: 'InterfaceSettings.tsx'
};
const source = (tab: string) =>
	readFileSync(resolve(process.cwd(), 'src/components/settings', TAB_FILES[tab]), 'utf8') +
	(tab === 'interface'
		? readFileSync(resolve(process.cwd(), 'src/components/settings/interfaceSettingDefs.ts'), 'utf8')
		: '');

describe('the settings index (#1001)', () => {
	it('points every entry at a personal tab', () => {
		const ids = new Set(personalTabs.map((t) => t.id));
		for (const s of SETTINGS_INDEX) expect(ids.has(s.tab), s.tab).toBe(true);
	});

	it.each(SETTINGS_INDEX.map((s) => [s.tab, s.label]))('finds %s › %s in that tab, as it is labelled', (tab, label) => {
		expect(source(tab)).toMatch(new RegExp(`["'\`]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`));
	});

	it('matches every word, in the label or the description, labels first', () => {
		const all = new Set(personalTabs.map((t) => t.id));
		expect(searchSettings('dark mode', all).map((s) => s.label)).toEqual(['Theme']);
		const wide = searchSettings('widescreen', all);
		expect(wide[0]).toMatchObject({ tab: 'interface', label: 'Widescreen Mode' });
		expect(searchSettings('password', all).map((s) => s.label)).toContain('Change Password');
		expect(searchSettings('sound', all)[0].label).toBe('Notification Sound');
		expect(searchSettings('   ', all)).toEqual([]);
		expect(searchSettings('zzqx', all)).toEqual([]);
	});

	it('leaves out tabs this user cannot open', () => {
		expect(searchSettings('theme', new Set(['interface']))).toEqual([]);
	});
});
