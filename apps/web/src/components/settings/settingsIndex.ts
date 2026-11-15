import { ROWS } from './interfaceSettingDefs';

/** One searchable setting: the tab it is on, its label as the tab shows it, and its description. */
export type IndexedSetting = { tab: string; label: string; description?: string };

/** The rows InterfaceSettings draws itself (see its renderCustom), with the words it shows. */
const INTERFACE_CUSTOM: Record<string, Omit<IndexedSetting, 'tab'>> = {
	textScale: { label: 'UI Scale', description: 'Set a local zoom level for the app interface.' },
	fontFamily: { label: 'Font Family', description: 'Use a local font family for the app interface.' },
	backgroundImage: {
		label: 'Chat Background Image',
		description: 'Upload or reset the image shown behind chat content.'
	}
};

/** Every Interface row a user can be offered, from the same table the tab renders. */
const interfaceSettings: IndexedSetting[] = Object.values(ROWS)
	.flat()
	.filter((row) => row.kind === 'custom' || !row.unported)
	.map((row) =>
		row.kind === 'custom'
			? { tab: 'interface', ...INTERFACE_CUSTOM[row.id] }
			: { tab: 'interface', label: row.label, description: row.description }
	);

/**
 * The settings of the other personal tabs, as each tab labels them (a row, a
 * field or a section heading). Kept by hand beside the tabs; a test checks that
 * every label still appears in its tab's source, so a renamed row fails the
 * build instead of silently falling out of search. Extra words a person may
 * type ("dark mode") go in `description`.
 */
const handListed: IndexedSetting[] = [
	{ tab: 'general', label: 'Theme', description: 'System, dark, black or light mode; colour theme; OLED' },
	{ tab: 'general', label: 'System prompt', description: 'Default instructions for new chats' },
	{ tab: 'general', label: 'Model parameters', description: 'Temperature, top p, max tokens, advanced parameters' },
	{ tab: 'notifications', label: 'Browser Notifications', description: 'Notify when a response completes' },
	{ tab: 'notifications', label: 'Notification Sound', description: 'Play a sound, chime' },
	{ tab: 'notifications', label: 'Notification Targets', description: 'Webhooks' },
	{ tab: 'shortcuts', label: 'Keyboard Shortcuts', description: 'Hotkeys, key bindings' },
	{ tab: 'personalization', label: 'Memory', description: 'Let the model remember things across chats' },
	{ tab: 'personalization', label: 'Saved memories', description: 'Add, edit or clear memories' },
	{ tab: 'audio', label: 'Language', description: 'Speech to text language' },
	{ tab: 'audio', label: 'Auto-Playback Response', description: 'Read responses aloud automatically, sound' },
	{ tab: 'audio', label: 'Speech Playback Speed', description: 'Text to speech rate' },
	{ tab: 'audio', label: 'Set Voice', description: 'Text to speech voice' },
	{ tab: 'data_controls', label: 'Import', description: 'Import chats from a JSON export' },
	{ tab: 'data_controls', label: 'Export', description: 'Export chats as JSON, backup' },
	{ tab: 'data_controls', label: 'Shared chats', description: 'Shared links, stop sharing' },
	{ tab: 'data_controls', label: 'Archive everything', description: 'Archive all chats' },
	{ tab: 'data_controls', label: 'Delete everything', description: 'Delete all chats' },
	{ tab: 'data_controls', label: 'Uploaded files', description: 'Manage files' },
	{ tab: 'account', label: 'Profile', description: 'Profile picture, avatar' },
	{ tab: 'account', label: 'Name', description: 'Your name, username' },
	{ tab: 'account', label: 'Bio' },
	{ tab: 'account', label: 'User Variables', description: 'Variables for prompts' },
	{ tab: 'account', label: 'Change Password', description: 'Password' },
	{ tab: 'account', label: 'API Key', description: 'Secret key' }
];

export const SETTINGS_INDEX: IndexedSetting[] = [...interfaceSettings, ...handListed];

/**
 * The settings whose label or description holds every word of `search`
 * (case-insensitive), on tabs this user can open, label matches first.
 */
export function searchSettings(search: string, openTabs: ReadonlySet<string>): IndexedSetting[] {
	const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const has = (text: string | undefined) => words.every((w) => (text ?? '').toLowerCase().includes(w));
	const matches = SETTINGS_INDEX.filter(
		(s) => openTabs.has(s.tab) && (has(s.label) || has(`${s.label} ${s.description ?? ''}`))
	);
	return [...matches.filter((s) => has(s.label)), ...matches.filter((s) => !has(s.label))];
}
