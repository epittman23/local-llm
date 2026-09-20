import type { PermissionGroupName, Permissions } from '@/lib/access/permissions';

export type PermissionContext = { pluginsEnabled: boolean };

export type PermissionRow = {
	group: PermissionGroupName;
	key: string;
	label: string;
	/** A tooltip on the label; the original uses it for the three risky switches. */
	warning?: string;
	/** Indented under its parent (the workspace Import/Export pair). Nested rows never show the "default" hint. */
	nested?: boolean;
	/** Row is only shown while this holds -- either a parent switch or a feature gate. */
	showIf?: (permissions: Permissions, context: PermissionContext) => boolean;
};

export type PermissionSection = { title: string; rows: PermissionRow[] };

const ARBITRARY_CODE = 'Warning: Enabling this will allow users to upload arbitrary code on the server.';
const SCHEDULED_PROMPTS = 'Warning: Enabling this will allow users to run scheduled prompts automatically.';

const row = (group: PermissionGroupName, key: string, label: string, extra: Partial<PermissionRow> = {}): PermissionRow => ({
	group,
	key,
	label,
	...extra
});

// One workspace resource: the access switch and, while it is on, its Import and Export.
const workspaceResource = (
	key: 'models' | 'prompts' | 'tools' | 'skills',
	noun: string,
	extra: Partial<PermissionRow> = {}
): PermissionRow[] => [
	row('workspace', key, `${noun} Access`, extra),
	row('workspace', `${key}_import`, `Import ${noun}`, {
		nested: true,
		showIf: (p, c) => p.workspace[key] && (extra.showIf?.(p, c) ?? true)
	}),
	row('workspace', `${key}_export`, `Export ${noun}`, {
		nested: true,
		showIf: (p, c) => p.workspace[key] && (extra.showIf?.(p, c) ?? true)
	})
];

// A sharing switch and the "Public Sharing" one that only means anything once it is on.
const sharingPair = (key: string, noun: string): PermissionRow[] => [
	row('sharing', key, `${noun} Sharing`),
	row('sharing', `public_${key}`, `${noun} Public Sharing`, { showIf: (p) => p.sharing[key] })
];

/**
 * The permission switches of admin/Users/Groups/Permissions.svelte as data: the
 * original spells out 66 near-identical blocks (label, switch, "this is a
 * default permission" hint) and this is the part that actually varies -- which
 * key, what it is called, and when it is visible. Order and labels are the
 * original's, unchanged.
 */
export const permissionSections: PermissionSection[] = [
	{
		title: 'Workspace Permissions',
		rows: [
			...workspaceResource('models', 'Models'),
			row('workspace', 'knowledge', 'Knowledge Access'),
			...workspaceResource('prompts', 'Prompts'),
			...workspaceResource('tools', 'Tools', { warning: ARBITRARY_CODE, showIf: (_p, c) => c.pluginsEnabled }),
			...workspaceResource('skills', 'Skills', { warning: ARBITRARY_CODE })
		]
	},
	{
		title: 'Sharing Permissions',
		rows: [
			...sharingPair('models', 'Models'),
			...sharingPair('knowledge', 'Knowledge'),
			...sharingPair('prompts', 'Prompts'),
			...sharingPair('tools', 'Tools'),
			...sharingPair('skills', 'Skills'),
			...sharingPair('notes', 'Notes'),
			row('sharing', 'folders', 'Folders Sharing'),
			row('sharing', 'public_chats', 'Chats Public Sharing', { showIf: (p) => p.chat.share }),
			row('sharing', 'open_chats', 'Chats Open Sharing', { showIf: (p) => p.chat.share }),
			row('sharing', 'public_calendars', 'Calendars Public Sharing', { showIf: (p) => p.features.calendar })
		]
	},
	{
		title: 'Access Grants',
		rows: [
			row('access_grants', 'allow_users', 'Allow Sharing With Users'),
			row('access_grants', 'allow_groups', 'Allow Sharing With Groups')
		]
	},
	{
		title: 'Chat Permissions',
		rows: [
			row('chat', 'file_upload', 'Allow File Upload'),
			row('chat', 'web_upload', 'Allow Web Upload'),
			row('chat', 'controls', 'Allow Chat Controls'),
			row('chat', 'valves', 'Allow Chat Valves', { showIf: (p) => p.chat.controls }),
			row('chat', 'system_prompt', 'Allow Chat System Prompt', { showIf: (p) => p.chat.controls }),
			row('chat', 'params', 'Allow Chat Params', { showIf: (p) => p.chat.controls }),
			row('chat', 'edit', 'Allow Chat Edit'),
			row('chat', 'delete', 'Allow Chat Delete'),
			row('chat', 'delete_message', 'Allow Delete Messages'),
			row('chat', 'continue_response', 'Allow Continue Response'),
			row('chat', 'regenerate_response', 'Allow Regenerate Response'),
			row('chat', 'rate_response', 'Allow Rate Response'),
			row('chat', 'share', 'Allow Chat Share'),
			row('chat', 'export', 'Allow Chat Export'),
			row('chat', 'import', 'Allow Chat Import'),
			row('chat', 'stt', 'Allow Speech to Text'),
			row('chat', 'tts', 'Allow Text to Speech'),
			row('chat', 'call', 'Allow Call'),
			row('chat', 'multiple_models', 'Allow Multiple Models in Chat'),
			row('chat', 'temporary', 'Allow Temporary Chat'),
			row('chat', 'temporary_enforced', 'Enforce Temporary Chat', { showIf: (p) => p.chat.temporary })
		]
	},
	{
		title: 'Features Permissions',
		rows: [
			row('features', 'api_keys', 'API Keys'),
			row('features', 'notes', 'Notes'),
			row('features', 'channels', 'Channels'),
			row('features', 'folders', 'Folders'),
			row('features', 'direct_tool_servers', 'Direct Tool Servers'),
			row('features', 'web_search', 'Web Search'),
			row('features', 'image_generation', 'Image Generation'),
			row('features', 'code_interpreter', 'Code Interpreter'),
			row('features', 'memories', 'Memories'),
			row('features', 'automations', 'Automations', { warning: SCHEDULED_PROMPTS }),
			row('features', 'calendar', 'Calendar'),
			row('features', 'webhooks', 'User Webhooks')
		]
	},
	{
		title: 'Settings Permissions',
		rows: [row('settings', 'interface', 'Interface Settings Access')]
	}
];

/** The rows of one section that are visible for these permissions. */
export const visibleRows = (section: PermissionSection, permissions: Permissions, context: PermissionContext) =>
	section.rows.filter((r) => r.showIf?.(permissions, context) ?? true);

/**
 * Whether to say "this is a default user permission and will remain enabled":
 * the group's own switch is off but the default for all users has it on, so
 * turning it off here changes nothing. Nested rows never show it.
 */
export const showsDefaultHint = (r: PermissionRow, permissions: Permissions, defaults: Partial<Permissions> | undefined) =>
	!r.nested && Boolean((defaults?.[r.group] as Record<string, boolean> | undefined)?.[r.key]) && !permissions[r.group][r.key];

/**
 * Splits visible rows into layout blocks: each top-level row stands alone, and
 * a run of consecutive nested rows (Import + Export) becomes one array, which
 * the component renders as a single indented block.
 */
export function layoutRows(rows: PermissionRow[]): (PermissionRow | PermissionRow[])[] {
	const blocks: (PermissionRow | PermissionRow[])[] = [];
	for (const r of rows) {
		const last = blocks[blocks.length - 1];
		if (r.nested && Array.isArray(last)) last.push(r);
		else blocks.push(r.nested ? [r] : r);
	}
	return blocks;
}
