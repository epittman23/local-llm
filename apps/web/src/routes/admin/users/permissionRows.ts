import type { PermissionGroupName, Permissions } from '@/lib/access/permissions';

export type PermissionContext = { pluginsEnabled: boolean };

export type PermissionRow = {
	group: PermissionGroupName;
	key: string;
	label: string;
	/** One line under the label saying what the switch allows (#1099). */
	description: string;
	/** A risk, shown under the description in the warning colour (it was a tooltip). */
	warning?: string;
	/** Indented under its parent (the workspace Import/Export pair). Nested rows never show the "default" hint. */
	nested?: boolean;
	/** Row is only shown while this holds -- either a parent switch or a feature gate. */
	showIf?: (permissions: Permissions, context: PermissionContext) => boolean;
};

export type PermissionSection = { title: string; rows: PermissionRow[] };

const ARBITRARY_CODE = 'Lets them run any code on the server.';
const SCHEDULED_PROMPTS = 'Prompts run on a schedule, with nobody watching.';

const row = (
	group: PermissionGroupName,
	key: string,
	label: string,
	description: string,
	extra: Partial<PermissionRow> = {}
): PermissionRow => ({
	group,
	key,
	label,
	description,
	...extra
});

// One workspace resource: the access switch and, while it is on, its Import and Export.
const workspaceResource = (
	key: 'models' | 'prompts' | 'tools' | 'skills',
	noun: string,
	description: string,
	extra: Partial<PermissionRow> = {}
): PermissionRow[] => [
	row('workspace', key, noun, description, extra),
	row('workspace', `${key}_import`, `Import ${noun.toLowerCase()}`, `Add ${noun.toLowerCase()} from a file.`, {
		nested: true,
		showIf: (p, c) => p.workspace[key] && (extra.showIf?.(p, c) ?? true)
	}),
	row('workspace', `${key}_export`, `Export ${noun.toLowerCase()}`, `Save ${noun.toLowerCase()} to a file.`, {
		nested: true,
		showIf: (p, c) => p.workspace[key] && (extra.showIf?.(p, c) ?? true)
	})
];

// A sharing switch and the "with everyone" one that only means anything once it is on.
const sharingPair = (key: string, noun: string): PermissionRow[] => [
	row('sharing', key, `Share ${noun}`, `Give chosen people and groups access to their ${noun}.`),
	row('sharing', `public_${key}`, `Share ${noun} with everyone`, `Give every account access to their ${noun}.`, {
		showIf: (p) => p.sharing[key]
	})
];

/**
 * The permission switches of admin/Users/Groups/Permissions.svelte as data: the
 * original spells out 66 near-identical blocks (label, switch, "this is a
 * default permission" hint) and this is the part that actually varies -- which
 * key, what it is called, what it allows, and when it is visible. The order is
 * the original's; the labels are plain words with a line each (#1099, WRD-1).
 */
export const permissionSections: PermissionSection[] = [
	{
		title: 'Workspace',
		rows: [
			...workspaceResource('models', 'Models', 'Create and edit model entries in Workspace.'),
			row('workspace', 'knowledge', 'Knowledge', 'Create knowledge bases and add documents to them.'),
			...workspaceResource('prompts', 'Prompts', 'Create and edit saved prompts.'),
			...workspaceResource('tools', 'Tools', 'Write Python tools that models can call.', {
				warning: ARBITRARY_CODE,
				showIf: (_p, c) => c.pluginsEnabled
			}),
			...workspaceResource('skills', 'Skills', 'Create and edit skills.', { warning: ARBITRARY_CODE })
		]
	},
	{
		title: 'Sharing',
		rows: [
			...sharingPair('models', 'models'),
			...sharingPair('knowledge', 'knowledge'),
			...sharingPair('prompts', 'prompts'),
			...sharingPair('tools', 'tools'),
			...sharingPair('skills', 'skills'),
			...sharingPair('notes', 'notes'),
			row('sharing', 'folders', 'Share folders', 'Give chosen people and groups access to their chat folders.'),
			row('sharing', 'public_chats', 'Share chats with everyone', 'Give every account access to a shared chat.', {
				showIf: (p) => p.chat.share
			}),
			row(
				'sharing',
				'open_chats',
				'Share chats without sign-in',
				'Let anyone with the link read a shared chat, signed in or not.',
				{ showIf: (p) => p.chat.share }
			),
			row(
				'sharing',
				'public_calendars',
				'Share calendars with everyone',
				'Give every account access to their calendars.',
				{ showIf: (p) => p.features.calendar }
			),
			row('sharing', 'public_channels', 'Make channels public', 'Create channels every account can join.', {
				showIf: (p) => p.features.channels
			})
		]
	},
	{
		title: 'Sharing with people and groups',
		rows: [
			row('access_grants', 'allow_users', 'Share with people', 'Pick individual accounts when sharing.'),
			row('access_grants', 'allow_groups', 'Share with groups', 'Pick groups when sharing.')
		]
	},
	{
		title: 'Chat',
		rows: [
			row('chat', 'file_upload', 'Upload files', 'Attach files to a message.'),
			row('chat', 'web_upload', 'Attach web pages', 'Attach a web page by its address.'),
			row('chat', 'controls', 'Chat controls', "Open the panel that changes a chat's settings."),
			row('chat', 'valves', 'Tool and function settings', 'Change the settings of tools and functions in a chat.', {
				showIf: (p) => p.chat.controls
			}),
			row('chat', 'system_prompt', 'System prompt', "Change a chat's system prompt.", {
				showIf: (p) => p.chat.controls
			}),
			row('chat', 'params', 'Model parameters', 'Change temperature and the other model parameters.', {
				showIf: (p) => p.chat.controls
			}),
			row('chat', 'edit', 'Edit messages', 'Change a sent message or a reply.'),
			row('chat', 'delete', 'Delete chats', 'Delete whole chats.'),
			row('chat', 'delete_message', 'Delete messages', 'Delete single messages from a chat.'),
			row('chat', 'continue_response', 'Continue replies', 'Ask a model to carry on a reply that stopped.'),
			row('chat', 'regenerate_response', 'Regenerate replies', 'Ask for a new reply in place of one.'),
			row('chat', 'rate_response', 'Rate replies', 'Rate a reply up or down.'),
			row('chat', 'share', 'Share chats', 'Make a link to a chat.'),
			row('chat', 'export', 'Export chats', 'Save chats to a file.'),
			row('chat', 'import', 'Import chats', 'Add chats from a file.'),
			row('chat', 'stt', 'Speech to text', 'Dictate a message.'),
			row('chat', 'tts', 'Text to speech', 'Have a reply read aloud.'),
			row('chat', 'call', 'Voice calls', 'Talk with a model in a voice call.'),
			row('chat', 'multiple_models', 'Several models at once', 'Ask more than one model in the same chat.'),
			row('chat', 'temporary', 'Temporary chats', 'Start chats that are not saved.'),
			row('chat', 'temporary_enforced', 'Only temporary chats', 'Every chat they start is temporary.', {
				showIf: (p) => p.chat.temporary
			})
		]
	},
	{
		title: 'Features',
		rows: [
			row('features', 'api_keys', 'API keys', 'Create keys to use the app from other programs.'),
			row('features', 'notes', 'Notes', 'Write notes.'),
			row('features', 'channels', 'Channels', 'Use channels.'),
			row('features', 'folders', 'Folders', 'Put chats in folders.'),
			row('features', 'direct_tool_servers', 'Own tool servers', 'Connect tool servers of their own.'),
			row('features', 'web_search', 'Web search', 'Let models search the web.'),
			row('features', 'image_generation', 'Image generation', 'Ask for images in chat.'),
			row('features', 'code_interpreter', 'Code interpreter', 'Let models run code in the sandbox.'),
			row('features', 'memories', 'Memories', 'Keep memories that models read in every chat.'),
			row('features', 'automations', 'Automations', 'Run prompts on a schedule.', { warning: SCHEDULED_PROMPTS }),
			row('features', 'calendar', 'Calendar', 'Use the calendar.'),
			row('features', 'webhooks', 'Webhooks', 'Send their notifications to a webhook address.')
		]
	},
	{
		title: 'Settings',
		rows: [
			row(
				'settings',
				'interface',
				'Personal settings',
				'Change the settings saved to their account: General, Interface, Notifications, Keyboard, Connections, Integrations, Personalization and Audio. Without it those tabs are hidden.'
			)
		]
	}
];

/** The rows of one section that are visible for these permissions. */
export const visibleRows = (section: PermissionSection, permissions: Permissions, context: PermissionContext) =>
	section.rows.filter((r) => r.showIf?.(permissions, context) ?? true);

/** The rows whose label or description holds every word of `query`, ignoring case. */
export function matchingRows(rows: PermissionRow[], query: string): PermissionRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows.filter((r) => {
		const text = `${r.label} ${r.description}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
}

/** The rows whose switch differs from `baseline` (what Reset would restore). */
export const changedRows = (rows: PermissionRow[], permissions: Permissions, baseline: Permissions) =>
	rows.filter((r) => Boolean(permissions[r.group][r.key]) !== Boolean(baseline[r.group]?.[r.key]));

/**
 * Whether to say "this is a default user permission and will remain enabled":
 * the group's own switch is off but the default for all users has it on, so
 * turning it off here changes nothing. Nested rows never show it.
 */
export const showsDefaultHint = (
	r: PermissionRow,
	permissions: Permissions,
	defaults: Partial<Permissions> | undefined
) =>
	!r.nested &&
	Boolean((defaults?.[r.group] as Record<string, boolean> | undefined)?.[r.key]) &&
	!permissions[r.group][r.key];

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
